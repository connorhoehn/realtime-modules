"use strict";
// useLVSHangout — composite WebRTC hangout hook built on the LVS
// (live-video-streaming) WHIP+WHEP primitives. Drop-in replacement for
// the IVS-Stage-based useHangoutEmbed in websocket-gateway/frontend.
//
// Contract: caller passes a participant token (the platform-api join
// response) + a per-tab participantId + a display name. The hook:
//   1. decodes the channel ARN from the token,
//   2. acquires camera+mic via getUserMedia,
//   3. publishes via useLVSPublisher (WHIP),
//   4. subscribes via useLVSSubscriber (WHEP) with our participantId
//      excluded so the SFU answer omits our own producers,
//   5. assembles a participants list keyed by msid (= publisher
//      participantId) so consumers can route tracks into per-tile UIs,
//   6. exposes mute/camera/screen-share toggles + leave().
//
// The composite owns capture; the underlying publisher hook is headless
// (caller-owned capture by design), so this layer is where getUserMedia
// + screen-share live.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLVSHangout = useLVSHangout;
const react_1 = require("react");
const jwt_1 = require("./lib/jwt");
const useLVSPublisher_1 = require("./useLVSPublisher");
const useLVSSubscriber_1 = require("./useLVSSubscriber");
const transport_1 = require("./lib/transport");
const LVSProvider_1 = require("./LVSProvider");
const sdp_1 = require("./lib/sdp");
/** Default capture constraints — 720p video + audio. Matches the IVS
 *  Stage-based useHangoutEmbed defaults so swap is visually identical. */
const DEFAULT_MEDIA = {
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
};
/** Recompute hasAudio/hasVideo flags by inspecting each stream's enabled
 *  tracks. Pure helper so participant updates stay declarative. */
function computeMediaFlags(streams) {
    let hasAudio = false;
    let hasVideo = false;
    for (const s of streams) {
        for (const t of s.getTracks()) {
            if (t.kind === 'audio' && t.enabled && t.readyState === 'live')
                hasAudio = true;
            if (t.kind === 'video' && t.enabled && t.readyState === 'live')
                hasVideo = true;
        }
    }
    return { hasAudio, hasVideo };
}
/**
 * Composite hangout hook. Wires WHIP (useLVSPublisher) + WHEP
 * (useLVSSubscriber) into a single participants-list API matching the
 * legacy IVS-Stage-based useHangoutEmbed surface, so consumers
 * (HangoutOverlay, HangoutDemoPage, VideoCallPanel) can swap with a
 * one-line import change.
 *
 * Lifecycle:
 *   - idle while `stageToken` or `participantId` is null
 *   - acquires camera+mic via getUserMedia on first valid input
 *   - autostarts publisher; subscriber excludes our participantId
 *   - `leave()` releases all local tracks + stops both legs
 *   - unmount cleanup mirrors `leave()` (idempotent)
 *
 * Track routing: the subscriber's onTrack fires per inbound track with
 * the SDP msid (= publisher participantId). We dedup by stream-id when
 * grouping into per-participant tiles.
 */
function useLVSHangout(opts) {
    const { stageToken, participantId, userId, media, baseUrl, getAuthToken } = opts;
    // ARN derivation: cheap + pure, memoize so we don't re-decode every
    // render. Null when the token is missing or malformed -> hook idles.
    const channelArn = (0, react_1.useMemo)(() => (0, jwt_1.decodeArn)(stageToken), [stageToken]);
    // Safe-context — null when caller forgot to mount <LVSProvider>. The
    // parallel-WHEP effect uses ctx?.baseUrl as the fallback when opts.baseUrl
    // is unset.
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    // Local capture state. The publisher hook is headless (caller-owned
    // capture), so this layer owns getUserMedia + screen-share swap.
    const [localStream, setLocalStream] = (0, react_1.useState)(null);
    const [localScreenStream, setLocalScreenStream] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const [isScreenSharing, setIsScreenSharing] = (0, react_1.useState)(false);
    const [remoteParticipants, setRemoteParticipants] = (0, react_1.useState)(new Map());
    // Bump on any local-track enabled toggle so participants memo
    // recomputes hasAudio/hasVideo without us re-rendering the streams ref.
    const [localFlagsTick, setLocalFlagsTick] = (0, react_1.useState)(0);
    const localStreamRef = (0, react_1.useRef)(null);
    const cameraStreamRef = (0, react_1.useRef)(null); // preserved across screen-share for restore
    const screenShareTrackRef = (0, react_1.useRef)(null);
    // P4 — parallel WHEP PCs for remote screen-share producers, keyed by
    // the producer's full participantId (e.g. "hank:screen"). Each entry
    // holds the live RTCPeerConnection + its WHEP resource URL so we can
    // DELETE on teardown. Managed imperatively from the
    // producer-discovery WS effect below — outside React's render path
    // because hooks can't be called in loops.
    const screenSubscribersRef = (0, react_1.useRef)(new Map());
    // Stable identity so the publisher hook doesn't observe a new
    // `getAuthToken` on every render (which would churn its useMemo and
    // potentially restart publish).
    const stageTokenRef = (0, react_1.useRef)(stageToken);
    stageTokenRef.current = stageToken;
    const customGetAuthRef = (0, react_1.useRef)(getAuthToken);
    customGetAuthRef.current = getAuthToken;
    const resolveAuthToken = (0, react_1.useCallback)(async () => {
        const custom = customGetAuthRef.current;
        if (custom)
            return custom();
        return stageTokenRef.current ?? '';
    }, []);
    // Capture camera+mic when token+participantId become valid. Re-runs
    // only when those primary inputs change (not media constraints — that
    // would teardown on every render if a parent re-creates the object).
    (0, react_1.useEffect)(() => {
        if (!channelArn || !participantId)
            return;
        let cancelled = false;
        setError(null);
        const constraints = media ?? DEFAULT_MEDIA;
        navigator.mediaDevices
            .getUserMedia(constraints)
            .then((stream) => {
            if (cancelled) {
                stream.getTracks().forEach((t) => t.stop());
                return;
            }
            localStreamRef.current = stream;
            cameraStreamRef.current = stream;
            setLocalStream(stream);
        })
            .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (!cancelled)
                setError(`getUserMedia failed: ${msg}`);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelArn, participantId]);
    // Publisher (WHIP). autoStart=true means the hook fires as soon as
    // both stream + channelArn are set. Idle while null.
    const publisher = (0, useLVSPublisher_1.useLVSPublisher)({
        channelArn: channelArn ?? '',
        stream: channelArn ? localStream : null,
        participantId: participantId ?? undefined,
        autoStart: true,
        baseUrl,
        getAuthToken: resolveAuthToken,
    });
    // P4 — second publisher dedicated to screen-share. Uses a synthetic
    // participantId suffix `${participantId}:screen` so the SFU treats
    // it as a separate publisher and remote subscribers can WHEP it as
    // its own producer (camera publisher stays untouched on the wire).
    // Auto-starts when `localScreenStream` is non-null, auto-tears-down
    // when it's nulled. Same auth resolver. Memoized so the publisher
    // hook's deps don't see a new string identity per render (would
    // re-bind start() each render — harmless today but keeps a stable
    // upstream contract).
    const screenParticipantId = (0, react_1.useMemo)(() => (participantId ? `${participantId}:screen` : undefined), [participantId]);
    const screenPublisher = (0, useLVSPublisher_1.useLVSPublisher)({
        channelArn: channelArn ?? '',
        stream: channelArn ? localScreenStream : null,
        participantId: screenParticipantId,
        autoStart: true,
        baseUrl,
        getAuthToken: resolveAuthToken,
    });
    // Subscriber (WHEP). excludeParticipantId scrubs our own producers
    // from the SFU answer so we don't render ourselves twice.
    const subscriber = (0, useLVSSubscriber_1.useLVSSubscriber)({
        channelArn: channelArn ?? '',
        autoStart: !!channelArn && !!participantId,
        excludeParticipantId: participantId ?? undefined,
        baseUrl,
        getAuthToken: resolveAuthToken,
        // Watch LVS producer-discovery WS for remote upgrades (audio-only
        // peer turning camera on, screenshare added, etc.). Triggers
        // re-WHEP so we receive the new track kind.
        watchProducerEvents: true,
        onTrack: (0, react_1.useCallback)((track, msid) => {
            // The SFU sets msid to `<participantId> <trackId>`, so msid is
            // the publisher's participantId. Tracks without a stream id
            // can't be tile-routed; skip them rather than bucket under '?'.
            if (!msid)
                return;
            // Skip echo from our own publisher in case the SFU answer
            // includes us despite excludeParticipantId (defense in depth).
            // Also skip our dedicated screen publisher whose pid namespace
            // is `${participantId}:screen` — equality-only would let our
            // own screen track render as a "remote".
            if (participantId && (msid === participantId || msid.startsWith(participantId + ':')))
                return;
            // Skip any remote screen producer here — `${pid}:screen` msid
            // means a dedicated screen publisher whose tracks are routed
            // through the parallel WHEP path (effect below) into
            // `entry.screenStream`. If the SFU's primary WHEP answer ever
            // also includes a screen producer (multiplex behavior may vary
            // by build), we'd otherwise create a phantom participant tile
            // keyed by `${pid}:screen` AND double-attach the track to both
            // the camera tile's streams[] and the dedicated screenStream.
            if (msid.includes(':'))
                return;
            setRemoteParticipants((prev) => {
                const next = new Map(prev);
                const existing = next.get(msid) ?? {
                    streams: [],
                    streamIds: new Set(),
                };
                // Each track arrives with a streams[] array; group tracks
                // sharing the same stream id (= msid namespace) into one
                // MediaStream so the consumer's <video srcObject> renders
                // synchronized A/V.
                let stream = existing.streams.find((s) => existing.streamIds.has(s.id));
                // First track for this participant: create a fresh MediaStream
                // (don't reuse ev.streams[0] — the subscriber aggregates ALL
                // inbound tracks into a single shared stream, which would
                // bleed across participant tiles).
                if (!stream) {
                    stream = new MediaStream();
                    existing.streams = [stream];
                    existing.streamIds.add(stream.id);
                }
                // Dedup by track id — onTrack can fire twice in some browsers
                // during renegotiation.
                if (!stream.getTracks().some((t) => t.id === track.id)) {
                    stream.addTrack(track);
                }
                next.set(msid, existing);
                return next;
            });
            // Prune the participant entry when the track ends.
            const onEnded = () => {
                setRemoteParticipants((prev) => {
                    const next = new Map(prev);
                    const entry = next.get(msid);
                    if (!entry)
                        return prev;
                    for (const s of entry.streams) {
                        if (s.getTracks().some((t) => t.id === track.id)) {
                            s.removeTrack(track);
                        }
                    }
                    // If all streams are now empty, drop the participant entirely.
                    const nonEmpty = entry.streams.filter((s) => s.getTracks().length > 0);
                    if (nonEmpty.length === 0) {
                        next.delete(msid);
                    }
                    else {
                        next.set(msid, { ...entry, streams: nonEmpty });
                    }
                    return next;
                });
            };
            track.addEventListener('ended', onEnded, { once: true });
        }, [participantId]),
    });
    // P4 — Parallel WHEP for remote screen-share producers.
    //
    // The SFU's WHEP answer carries one producer per kind (cam OR
    // screen — not both) per session. To consume a remote's screen in
    // ADDITION to their camera, we open a SECOND WHEP PC targeting the
    // `${pid}:screen` participantId. This effect manages those PCs
    // imperatively (one per remote sharer) via the LVS producer-
    // discovery WS at `/api/channels/:arn/ws`.
    //
    // Lifecycle:
    //   - on `producer.added` with participantId ending `:screen` →
    //     open a new WHEP PC + route its video track to
    //     remoteParticipants.get(basePid).screenStream
    //   - on `producer.removed` → close the PC + drop the screenStream
    //   - on unmount → close every PC + DELETE every WHEP resource
    (0, react_1.useEffect)(() => {
        if (!channelArn)
            return;
        if (!participantId)
            return;
        const baseUrl = opts.baseUrl ?? ctx?.baseUrl;
        if (!baseUrl)
            return;
        let cancelled = false;
        let ws = null;
        const cleanupPc = (fullPid) => {
            const entry = screenSubscribersRef.current.get(fullPid);
            if (!entry)
                return;
            // Permanent diagnostic — paired with the open log so we can grep
            // open/close transitions when the spotlight inevitably regresses.
            console.info('[screen-pc] close', { fullPid });
            try {
                entry.pc.close();
            }
            catch { /* ignore */ }
            // Fire-and-forget DELETE — best effort.
            void (0, transport_1.whepTeardown)(entry.resourceUrl, entry.authToken).catch(() => { });
            screenSubscribersRef.current.delete(fullPid);
            // Drop the screenStream from the base participant entry.
            const basePid = fullPid.split(':')[0] ?? fullPid;
            setRemoteParticipants((prev) => {
                const next = new Map(prev);
                const e = next.get(basePid);
                if (!e)
                    return prev;
                if (e.screenStream) {
                    next.set(basePid, { ...e, screenStream: undefined });
                }
                return next;
            });
        };
        const openPcFor = async (fullPid) => {
            // Idempotent — bail if already subscribed.
            if (screenSubscribersRef.current.has(fullPid))
                return;
            // Don't self-subscribe (defense in depth — our own screen
            // publisher uses `${participantId}:screen` which the SFU
            // broadcasts back via the discovery WS).
            if (fullPid === `${participantId}:screen`)
                return;
            try {
                const authToken = await resolveAuthToken();
                const ice = await (0, transport_1.fetchIceServers)(baseUrl);
                // Permanent diagnostic — log every parallel WHEP attempt so the
                // next regression is one browser-console scroll away. Pair with
                // SFU-side `WHEP producer found` log lines via fullPid to verify
                // the WHEP reached the server with the `:screen` suffix intact.
                console.info('[screen-pc] open', { fullPid, hasIce: ice.length > 0 });
                const pc = new RTCPeerConnection({ iceServers: ice });
                // Recv-only — screen producers are video (audio optional).
                pc.addTransceiver('video', { direction: 'recvonly' });
                pc.addTransceiver('audio', { direction: 'recvonly' });
                pc.addEventListener('track', (ev) => {
                    if (cancelled)
                        return;
                    const track = ev.track;
                    const incomingStream = ev.streams[0] ?? new MediaStream([track]);
                    const basePid = fullPid.split(':')[0] ?? fullPid;
                    console.info('[screen-pc] track', {
                        fullPid,
                        basePid,
                        kind: track.kind,
                        streamId: incomingStream.id,
                    });
                    setRemoteParticipants((prev) => {
                        const next = new Map(prev);
                        const existing = next.get(basePid) ?? {
                            streams: [],
                            streamIds: new Set(),
                        };
                        // Keep camera streams[] untouched — only attach screen
                        // here. We use a dedicated MediaStream so the consumer
                        // can render screenStream in a separate <video> element
                        // from streams[0] (camera).
                        let screen = existing.screenStream;
                        if (!screen) {
                            screen = new MediaStream();
                        }
                        if (!screen.getTracks().some((t) => t.id === track.id)) {
                            screen.addTrack(track);
                        }
                        next.set(basePid, { ...existing, screenStream: screen });
                        return next;
                    });
                    // Drop on track end (publisher unpublished).
                    track.addEventListener('ended', () => cleanupPc(fullPid), { once: true });
                });
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await (0, sdp_1.waitForIceGather)(pc, 3000);
                const sdp = pc.localDescription?.sdp;
                if (!sdp)
                    throw new Error('failed to generate local SDP');
                const { answerSdp, location } = await (0, transport_1.whepPublish)({
                    channelArn,
                    offerSdp: sdp,
                    authToken,
                    // Target THIS publisher's screen producer specifically —
                    // without it the SFU's first-match path returns the publisher's
                    // CAMERA instead of their screen track, so a remote screen-share
                    // would render as a duplicate camera tile.
                    participantId: fullPid,
                    excludeParticipantId: undefined,
                    baseUrl,
                }).catch((e) => {
                    // No producers yet (race between WS event + WHIP completion)
                    // — silently bail; the next producer.added retry catches it.
                    throw e;
                });
                await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
                if (cancelled) {
                    try {
                        pc.close();
                    }
                    catch { /* */ }
                    if (location)
                        void (0, transport_1.whepTeardown)(location, authToken).catch(() => { });
                    return;
                }
                if (!location) {
                    // No Location header — server didn't issue a WHEP resource
                    // URL, so we can't DELETE on teardown. Bail with cleanup
                    // (the PC stays connected for the session lifetime; consumer
                    // gets the track but we can't release the SFU consumer
                    // cleanly). Should never happen with a spec-compliant server.
                    try {
                        pc.close();
                    }
                    catch { /* */ }
                    return;
                }
                screenSubscribersRef.current.set(fullPid, {
                    pc,
                    resourceUrl: location,
                    authToken,
                });
            }
            catch (e) {
                // Cleanup any partial state — next discovery tick may retry.
                const entry = screenSubscribersRef.current.get(fullPid);
                if (entry) {
                    try {
                        entry.pc.close();
                    }
                    catch { /* */ }
                    screenSubscribersRef.current.delete(fullPid);
                }
            }
        };
        const wsUrl = baseUrl.replace(/^http/, 'ws') +
            `/api/channels/${encodeURIComponent(channelArn)}/ws`;
        try {
            ws = new WebSocket(wsUrl);
            // Subscribe-channel handshake — stageWsServer only delivers
            // producer events after receiving this frame.
            ws.addEventListener('open', () => {
                void (async () => {
                    try {
                        const token = await resolveAuthToken();
                        ws?.send(JSON.stringify({
                            type: 'subscribe-channel',
                            channelArn,
                            participantId,
                            token,
                        }));
                    }
                    catch { /* token resolver threw — discovery silent, parallel WHEP screen-share won't surface */ }
                })();
            });
            ws.addEventListener('message', (ev) => {
                try {
                    const msg = JSON.parse(ev.data);
                    const pid = msg?.participantId;
                    if (typeof pid !== 'string' || !pid.endsWith(':screen'))
                        return;
                    // Permanent diagnostic — log every screen-related discovery
                    // event so a future regression in the producer.added wiring
                    // is visible without re-instrumenting. Kept info-level since
                    // these fire ~once per screen-share start/stop (rare).
                    console.info('[screen-discovery] event', {
                        type: msg.type,
                        participantId: pid,
                        kind: msg.kind,
                    });
                    if (msg.type === 'producer.added' && msg.kind === 'video') {
                        void openPcFor(pid);
                    }
                    else if (msg.type === 'producer.removed') {
                        cleanupPc(pid);
                    }
                }
                catch { /* malformed frame — ignore */ }
            });
        }
        catch { /* WS construction failure — silent fail-open */ }
        return () => {
            cancelled = true;
            try {
                ws?.close();
            }
            catch { /* */ }
            // Snapshot keys; cleanup mutates the map.
            const keys = Array.from(screenSubscribersRef.current.keys());
            for (const k of keys)
                cleanupPc(k);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelArn, participantId, opts.baseUrl]);
    // toggleMute / toggleCamera flip `enabled` on the local tracks. No
    // SDP renegotiation — the publisher's transceivers stay live; we just
    // null the outbound media. Bump localFlagsTick so participants memo
    // recomputes hasAudio/hasVideo.
    const toggleMute = (0, react_1.useCallback)((muted) => {
        const s = localStreamRef.current;
        if (!s)
            return;
        for (const t of s.getAudioTracks())
            t.enabled = !muted;
        setLocalFlagsTick((n) => n + 1);
    }, []);
    const toggleCamera = (0, react_1.useCallback)((off) => {
        const s = localStreamRef.current;
        if (!s)
            return;
        for (const t of s.getVideoTracks())
            t.enabled = !off;
        setLocalFlagsTick((n) => n + 1);
    }, []);
    const stopScreenShare = (0, react_1.useCallback)(() => {
        // P4 — clearing localScreenStream causes the dedicated
        // screenPublisher to teardown its WHIP transport (DELETE),
        // which fires `producer.removed` to subscribers. The camera
        // publisher is untouched. No track-swap, no restore step.
        const track = screenShareTrackRef.current;
        if (track) {
            try {
                track.stop();
            }
            catch { /* ignore */ }
            screenShareTrackRef.current = null;
        }
        setLocalScreenStream(null);
        setIsScreenSharing(false);
    }, []);
    const startScreenShare = (0, react_1.useCallback)(async () => {
        try {
            const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const videoTrack = display.getVideoTracks()[0];
            if (!videoTrack) {
                display.getTracks().forEach((t) => t.stop());
                return;
            }
            screenShareTrackRef.current = videoTrack;
            // P4 — multi-stream design. Setting `localScreenStream` causes
            // the dedicated screenPublisher (configured above) to autoStart
            // a SECOND WHIP transport with `participantId: ${pid}:screen`.
            // The camera publisher stays untouched — remote viewers see BOTH
            // the sharer's camera AND their screen at the same time.
            // (Old v1 path here called `publisher.replaceStream(swap)` which
            // swapped the camera track for the screen, hiding the sharer's
            // face from remotes. Gone.)
            setLocalScreenStream(display);
            setIsScreenSharing(true);
            // Browser-chrome "Stop sharing" button fires `ended` on the
            // captured video track. Mirror our stopScreenShare path so the
            // screenPublisher tears down cleanly.
            videoTrack.addEventListener('ended', () => {
                if (screenShareTrackRef.current === videoTrack) {
                    screenShareTrackRef.current = null;
                    setLocalScreenStream(null);
                    setIsScreenSharing(false);
                }
            }, { once: true });
        }
        catch (e) {
            const err = e;
            // User cancelled the picker — not an error.
            if (err?.name === 'AbortError' || err?.name === 'NotAllowedError')
                return;
            const msg = e instanceof Error ? e.message : String(e);
            setError(`Screen share failed: ${msg}`);
        }
    }, []);
    /**
     * Acquire camera + re-publish with audio + video. Used when the
     * call started audio-only and the user wants to turn video on. The
     * existing audio track is preserved (taken from the current local
     * stream); only the video track is freshly captured.
     */
    const enableCamera = (0, react_1.useCallback)(async () => {
        const existing = localStreamRef.current;
        const alreadyHasVideo = existing?.getVideoTracks().some((t) => t.readyState === 'live');
        if (alreadyHasVideo)
            return; // idempotent
        try {
            const camStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            });
            const videoTrack = camStream.getVideoTracks()[0];
            if (!videoTrack) {
                camStream.getTracks().forEach((t) => t.stop());
                return;
            }
            // Build the new combined stream: keep existing audio (if any) +
            // the new video track.
            const merged = new MediaStream();
            if (existing) {
                for (const t of existing.getAudioTracks())
                    merged.addTrack(t);
            }
            merged.addTrack(videoTrack);
            localStreamRef.current = merged;
            cameraStreamRef.current = merged;
            setLocalStream(merged);
            await publisher.republish(merged);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(`Failed to enable camera: ${msg}`);
        }
    }, [publisher]);
    /**
     * Drop the camera track + re-publish audio-only. Used to downgrade
     * mid-call. Stops the video track to release the device + LED.
     */
    const disableCamera = (0, react_1.useCallback)(async () => {
        const existing = localStreamRef.current;
        if (!existing)
            return;
        const videoTracks = existing.getVideoTracks();
        if (videoTracks.length === 0)
            return; // already audio-only
        // Stop the video tracks (releases the device + camera LED).
        videoTracks.forEach((t) => { try {
            t.stop();
        }
        catch { /* */ } });
        // Build audio-only stream from remaining audio tracks.
        const audioOnly = new MediaStream();
        for (const t of existing.getAudioTracks())
            audioOnly.addTrack(t);
        localStreamRef.current = audioOnly;
        cameraStreamRef.current = audioOnly;
        setLocalStream(audioOnly);
        try {
            await publisher.republish(audioOnly);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(`Failed to disable camera: ${msg}`);
        }
    }, [publisher]);
    const leave = (0, react_1.useCallback)(() => {
        // Stop the screen-share track first so its `ended` handler doesn't
        // race the publisher teardown.
        const screen = screenShareTrackRef.current;
        if (screen) {
            try {
                screen.stop();
            }
            catch { /* ignore */ }
            screenShareTrackRef.current = null;
        }
        setIsScreenSharing(false);
        void publisher.stop();
        void subscriber.stop();
        const s = localStreamRef.current;
        if (s) {
            s.getTracks().forEach((t) => {
                try {
                    t.stop();
                }
                catch { /* ignore */ }
            });
        }
        localStreamRef.current = null;
        cameraStreamRef.current = null;
        setLocalStream(null);
        setLocalScreenStream(null);
        setRemoteParticipants(new Map());
    }, [publisher, subscriber]);
    // Unmount cleanup: same as leave(), but the publisher/subscriber hooks
    // also run their own teardown — so we only release local tracks here
    // to avoid double-stopping the WHIP/WHEP resources.
    (0, react_1.useEffect)(() => {
        return () => {
            const screen = screenShareTrackRef.current;
            if (screen) {
                try {
                    screen.stop();
                }
                catch { /* ignore */ }
            }
            const s = localStreamRef.current;
            if (s) {
                s.getTracks().forEach((t) => {
                    try {
                        t.stop();
                    }
                    catch { /* ignore */ }
                });
            }
            localStreamRef.current = null;
            cameraStreamRef.current = null;
            screenShareTrackRef.current = null;
        };
    }, []);
    // Surface error from either leg. Subscriber failures shouldn't blow
    // up the UI if the publisher is fine (e.g. solo room, no producers
    // yet); we only escalate publisher errors as fatal.
    const composedError = error ?? publisher.error ?? null;
    // Build the public participants list. Local user first; remotes
    // appended in insertion order (Map preserves it).
    const participants = (0, react_1.useMemo)(() => {
        const list = [];
        // Local participant — present whenever we have a participantId,
        // even before media lands. The streams[] is empty until
        // getUserMedia resolves; consumers can render a placeholder.
        if (participantId) {
            const localStreams = [];
            if (localStreamRef.current)
                localStreams.push(localStreamRef.current);
            const flags = computeMediaFlags(localStreams);
            list.push({
                participantId,
                displayName: userId,
                userId,
                isLocal: true,
                streams: localStreams,
                screenStream: localScreenStream ?? undefined,
                hasAudio: flags.hasAudio,
                hasVideo: flags.hasVideo,
            });
        }
        // Remotes.
        for (const [pid, entry] of remoteParticipants.entries()) {
            // computeMediaFlags must consider the camera streams AND the
            // dedicated parallel-WHEP screenStream — a screen-only peer (camera
            // off, sharing) needs hasVideo=true so consumers don't render them
            // as a "no video" placeholder. Without including screenStream here,
            // a camera-off sharer reads as hasVideo=false even though their
            // screen track is live.
            const flagSources = entry.screenStream
                ? [...entry.streams, entry.screenStream]
                : entry.streams;
            const flags = computeMediaFlags(flagSources);
            list.push({
                participantId: pid,
                displayName: pid, // falls back to participantId — no name channel from SFU
                userId: pid,
                isLocal: false,
                streams: entry.streams,
                // BUG-FIX (2026-05-23): expose screenStream for remote
                // participants. Without this the parallel-WHEP path successfully
                // pulled the screen track via `${pid}:screen` and stashed it on
                // the internal map, but the public HangoutParticipant never
                // carried it out — so consumers (HangoutOverlay spotlight) fell
                // through to `streams[0]` (camera) and the OTHER peer kept
                // seeing the sharer's CAMERA in the spotlight slot, not their
                // screen. The parallel WHEP was succeeding all along (verified
                // via SFU logs showing `WHEP producer found` for `:screen`
                // pids); the bug was a missing field in the participants memo.
                screenStream: entry.screenStream,
                hasAudio: flags.hasAudio,
                hasVideo: flags.hasVideo,
            });
        }
        return list;
        // localFlagsTick + localStream + localScreenStream included so
        // flag changes / screen-share toggles recompute.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [participantId, userId, remoteParticipants, localStream, localScreenStream, localFlagsTick]);
    // isJoined: publisher live is the primary signal — we've successfully
    // pushed bytes to the SFU. Subscriber may legitimately be 'connecting'
    // forever when alone in the lobby (no remote producers to answer
    // with), so we don't gate on subscriber phase. This matches the
    // legacy useHangoutEmbed UX where the UI mounts as soon as Stage
    // joined, regardless of whether others were already there.
    const isJoined = publisher.phase === 'live';
    // Camera state: did the local participant actually publish a live
    // video track? Drives the in-call "Turn on camera" button visibility.
    const isCameraEnabled = (0, react_1.useMemo)(() => !!localStream && localStream.getVideoTracks().some((t) => t.readyState === 'live'), [localStream]);
    return {
        participants,
        isJoined,
        isScreenSharing,
        isCameraEnabled,
        error: composedError,
        toggleMute,
        toggleCamera,
        enableCamera,
        disableCamera,
        startScreenShare,
        stopScreenShare,
        leave,
    };
}
//# sourceMappingURL=useLVSHangout.js.map