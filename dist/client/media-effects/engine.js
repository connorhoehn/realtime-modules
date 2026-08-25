"use strict";
// realtime-modules/src/client/media-effects/engine.ts
//
// MediaEffectsEngine — the non-React core of the media-effects subpath.
//
// The reference implementation (videonowandlater's useFilterPipeline) built
// a canvas pipeline the moment a stream was wrapped, even with every effect
// off — burning a RAF loop + captureStream on people who never touch a
// filter. This engine is LAZY instead:
//
//   - While inactive (filter 'none', background 'none', no sprite) there is
//     NO canvas, NO RAF loop, and getOutputTrack() returns the raw source
//     track — identity passthrough, zero cost.
//   - On the inactive→active edge the pipeline is built (hidden <video>
//     playing the source track, output/bg/person canvases allocated once,
//     RAF draw loop, canvas.captureStream(30)) and the output becomes the
//     canvas track. On the active→inactive edge it is torn down and the
//     output reverts to the raw track.
//   - Setting changes while active are plain field reads in the draw loop —
//     no rebuild, no output identity change, so downstream consumers
//     (RTCRtpSender.replaceTrack etc.) only hear from onOutputChange when
//     the track identity actually changes.
//
// Every DOM/global construction goes through small protected factory
// methods so unit tests can subclass the engine and exercise the state
// machine without jsdom, canvas, or MediaPipe.
//
// Ownership: the engine NEVER stops the source track — the caller acquired
// it (getUserMedia) and owns its lifecycle. Only pipeline-created canvas
// tracks are stopped on teardown.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaEffectsEngine = void 0;
const presets_1 = require("./presets");
const segmenter_1 = require("./segmenter");
const faceLandmarker_1 = require("./faceLandmarker");
const faceSprites_1 = require("./faceSprites");
class MediaEffectsEngine {
    source = null;
    filterId = 'none';
    backgroundMode = 'none';
    backgroundImageUrl = null;
    backgroundImage = null;
    faceSpriteId = null;
    pipeline = null;
    listeners = new Set();
    disposed = false;
    // Bound once so add/removeEventListener pair correctly across setSource calls.
    handleSourceEnded = () => {
        // A dead camera track can't feed the pipeline; tear down and tell
        // consumers the output is gone rather than freezing on the last frame.
        const prev = this.getOutputTrack();
        this.teardownPipeline();
        if (this.source) {
            this.source.removeEventListener?.('ended', this.handleSourceEnded);
        }
        this.source = null;
        this.emitIfChanged(prev);
    };
    // ---------------------------------------------------------------- state
    getFilterId() { return this.filterId; }
    getBackgroundMode() { return this.backgroundMode; }
    getBackgroundImageUrl() { return this.backgroundImageUrl; }
    getFaceSpriteId() { return this.faceSpriteId; }
    getSource() { return this.source; }
    /** Active = at least one effect is on. Drives pipeline existence. */
    isActive() {
        return this.filterId !== 'none' || this.backgroundMode !== 'none' || this.faceSpriteId != null;
    }
    /** Canvas track while active, raw source track while inactive. */
    getOutputTrack() {
        return this.pipeline?.outputTrack ?? this.source;
    }
    /** Fired whenever output identity changes (activation, deactivation,
     *  setSource, source ended). Returns unsubscribe. */
    onOutputChange(cb) {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }
    // -------------------------------------------------------------- source
    setSource(track) {
        if (track === this.source)
            return;
        const prev = this.getOutputTrack();
        if (this.source) {
            this.source.removeEventListener?.('ended', this.handleSourceEnded);
        }
        // A pipeline is bound to its <video> element's stream, so a new source
        // means rebuild (fresh capture), not repoint.
        this.teardownPipeline();
        this.source = track;
        if (track && !this.disposed) {
            track.addEventListener?.('ended', this.handleSourceEnded);
            if (this.isActive())
                this.buildPipeline();
        }
        this.emitIfChanged(prev);
    }
    // ------------------------------------------------------------- setters
    setFilter(id) {
        if (id === this.filterId)
            return;
        const prev = this.getOutputTrack();
        this.filterId = id;
        this.syncPipeline();
        this.emitIfChanged(prev);
    }
    setBackgroundMode(mode) {
        if (mode === this.backgroundMode)
            return;
        const prev = this.getOutputTrack();
        this.backgroundMode = mode;
        this.syncPipeline();
        if (mode === 'blur' || mode === 'image') {
            // Kick the ~3 MB model download now so the first composited frame
            // isn't preceded by seconds of un-blurred passthrough.
            this.pipeline?.segmenter.warmup();
        }
        this.emitIfChanged(prev);
    }
    setBackgroundImageUrl(url) {
        this.backgroundImageUrl = url;
        if (!url) {
            this.backgroundImage = null;
            return;
        }
        this.loadBackgroundImage(url, (img) => {
            // Ignore stale loads: only latch if this is still the wanted url.
            if (this.backgroundImageUrl === url)
                this.backgroundImage = img;
        });
    }
    setFaceSpriteId(id) {
        if (id === this.faceSpriteId)
            return;
        const prev = this.getOutputTrack();
        this.faceSpriteId = id;
        this.syncPipeline();
        if (id) {
            // Same rationale as segmenter warmup: fetch the landmark model early.
            this.pipeline?.faceTracker.warmup();
        }
        this.emitIfChanged(prev);
    }
    // ------------------------------------------------------------ lifecycle
    /** Full teardown. Never stops the source track (caller owns it). */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.teardownPipeline();
        if (this.source) {
            this.source.removeEventListener?.('ended', this.handleSourceEnded);
            this.source = null;
        }
        this.listeners.clear();
    }
    // ----------------------------------------------- pipeline state machine
    syncPipeline() {
        const shouldRun = this.isActive() && !!this.source && !this.disposed;
        if (shouldRun && !this.pipeline) {
            this.buildPipeline();
        }
        else if (!shouldRun && this.pipeline) {
            this.teardownPipeline();
        }
    }
    buildPipeline() {
        const track = this.source;
        if (!track || this.pipeline)
            return;
        const settings = track.getSettings?.() ?? {};
        const width = settings.width ?? 1280;
        const height = settings.height ?? 720;
        const video = this.createVideoElement(track);
        const outputCanvas = this.createCanvas(width, height);
        // Auxiliary canvases for the background pipeline. Allocated up front so
        // we don't churn on every frame; sizes re-synced in the draw loop when
        // the track's real dimensions differ (rotation, constraint changes).
        const bgCanvas = this.createCanvas(width, height);
        const personCanvas = this.createCanvas(width, height);
        const outputCtx = outputCanvas.getContext?.('2d') ?? null;
        const stream = this.captureCanvasStream(outputCanvas);
        const outputTrack = stream?.getVideoTracks?.()[0] ?? null;
        const pipeline = {
            video,
            outputCanvas,
            bgCanvas,
            personCanvas,
            outputCtx,
            rafId: 0,
            stream,
            outputTrack,
            segmenter: this.createSegmenter(),
            faceTracker: this.createFaceTracker(),
            startTimeMs: this.now(),
        };
        this.pipeline = pipeline;
        const loop = () => {
            // Schedule first so a draw exception can't kill the loop permanently.
            pipeline.rafId = this.requestFrame(loop);
            try {
                this.drawFrame(pipeline);
            }
            catch {
                // A single bad frame (MediaPipe hiccup, detached context) is
                // dropped; the next frame retries.
            }
        };
        pipeline.rafId = this.requestFrame(loop);
    }
    teardownPipeline() {
        const p = this.pipeline;
        if (!p)
            return;
        this.pipeline = null;
        this.cancelFrame(p.rafId);
        try {
            p.video.pause?.();
        }
        catch { /* detached element */ }
        try {
            p.video.srcObject = null;
        }
        catch { /* ignore */ }
        try {
            p.segmenter.close();
        }
        catch { /* ignore */ }
        try {
            p.faceTracker.close();
        }
        catch { /* ignore */ }
        // Stop only pipeline-created (canvas capture) tracks — never the source.
        if (p.stream) {
            for (const t of p.stream.getTracks?.() ?? []) {
                if (t !== this.source) {
                    try {
                        t.stop();
                    }
                    catch { /* already stopped */ }
                }
            }
        }
    }
    // ------------------------------------------------------------ draw loop
    drawFrame(p) {
        const { video, outputCanvas, bgCanvas, personCanvas, outputCtx } = p;
        if (!outputCtx)
            return;
        if ((video.readyState ?? 0) < 2)
            return;
        // Dimension sync: the reference claimed to handle track resizes but
        // never did. Rotation / applyConstraints can change videoWidth/Height
        // mid-stream; resize all canvases together or the composite smears.
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw && vh && (outputCanvas.width !== vw || outputCanvas.height !== vh)) {
            outputCanvas.width = bgCanvas.width = personCanvas.width = vw;
            outputCanvas.height = bgCanvas.height = personCanvas.height = vh;
        }
        const w = outputCanvas.width;
        const h = outputCanvas.height;
        const cssFilter = (0, presets_1.getFilterById)(this.filterId).cssFilter;
        const bgMode = this.backgroundMode;
        let composited = false;
        if (bgMode === 'blur' || bgMode === 'image') {
            const ts = this.now() - p.startTimeMs;
            let maskCanvas = null;
            try {
                maskCanvas = p.segmenter.segment(video, ts);
            }
            catch {
                // Failed segmentation frame → fall back to plain filtered draw.
                maskCanvas = null;
            }
            if (maskCanvas) {
                // Background layer: blurred frame or a user-chosen cover-fit image.
                const bgCtx = bgCanvas.getContext('2d');
                if (bgCtx) {
                    if (bgMode === 'image' && this.backgroundImage) {
                        const img = this.backgroundImage;
                        const s = Math.max(w / img.width, h / img.height);
                        const dw = img.width * s;
                        const dh = img.height * s;
                        bgCtx.filter = 'none';
                        bgCtx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
                    }
                    else {
                        bgCtx.filter = 'blur(14px)';
                        bgCtx.drawImage(video, 0, 0, w, h);
                        bgCtx.filter = 'none';
                    }
                }
                // Person cutout: filtered frame masked to person silhouette.
                const personCtx = personCanvas.getContext('2d');
                if (personCtx) {
                    personCtx.globalCompositeOperation = 'source-over';
                    personCtx.filter = cssFilter;
                    personCtx.drawImage(video, 0, 0, w, h);
                    personCtx.filter = 'none';
                    personCtx.globalCompositeOperation = 'destination-in';
                    personCtx.drawImage(maskCanvas, 0, 0, w, h);
                    personCtx.globalCompositeOperation = 'source-over';
                }
                outputCtx.filter = 'none';
                outputCtx.drawImage(bgCanvas, 0, 0, w, h);
                outputCtx.drawImage(personCanvas, 0, 0, w, h);
                composited = true;
            }
        }
        if (!composited) {
            outputCtx.filter = cssFilter;
            outputCtx.drawImage(video, 0, 0, w, h);
        }
        // Face sprites — rendered last, on top of everything else. Runs only
        // when a sprite is selected so the Landmarker isn't invoked for users
        // who don't touch the feature.
        const spriteId = this.faceSpriteId;
        if (spriteId) {
            const sprite = (0, faceSprites_1.getSpriteById)(spriteId);
            if (sprite) {
                try {
                    const ts = this.now() - p.startTimeMs;
                    const landmarks = p.faceTracker.detect(video, ts);
                    if (landmarks) {
                        outputCtx.filter = 'none';
                        sprite.render(outputCtx, landmarks, w, h);
                    }
                }
                catch {
                    // Sprite failures never take down the composited frame.
                }
            }
        }
    }
    // ------------------------------------------------------------ listeners
    emitIfChanged(prev) {
        const next = this.getOutputTrack();
        if (next === prev)
            return;
        for (const cb of [...this.listeners]) {
            try {
                cb(next);
            }
            catch { /* listener errors are theirs */ }
        }
    }
    // ------------------------------------------------------------ factories
    //
    // All DOM/global construction is funneled through these so tests can
    // subclass and stub them — the state machine above is then exercisable
    // in plain node with fake tracks/canvases.
    createVideoElement(track) {
        const video = document.createElement('video');
        video.srcObject = new MediaStream([track]);
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        void video.play().catch(() => { });
        return video;
    }
    createCanvas(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    captureCanvasStream(canvas) {
        // Some environments (older Safari embeds, headless) lack captureStream;
        // without it we keep the raw track as output rather than going dark.
        if (typeof canvas.captureStream !== 'function')
            return null;
        return canvas.captureStream(30);
    }
    createSegmenter() {
        return new segmenter_1.PersonSegmenter();
    }
    createFaceTracker() {
        return new faceLandmarker_1.FaceTracker();
    }
    loadBackgroundImage(url, onLoad) {
        if (typeof Image === 'undefined')
            return;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => onLoad(img);
        img.src = url;
    }
    requestFrame(cb) {
        return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0;
    }
    cancelFrame(id) {
        if (typeof cancelAnimationFrame === 'function')
            cancelAnimationFrame(id);
    }
    now() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
}
exports.MediaEffectsEngine = MediaEffectsEngine;
//# sourceMappingURL=engine.js.map