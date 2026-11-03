# Camera effects for calls

`useCallMediaEffects` from `@connorhoehn/realtime-modules/client/video` wraps
`useMediaEffects` with call-wide, locally persisted preferences. `CALL_MEDIA_EFFECTS_KEY`
names the browser storage entry. Separate mounted controllers synchronize background,
image, filter and face choices while retaining independent engines and camera sources.

The shared call host uses one controller for its pre-join preview. `useConversationCall`
uses another for the native publisher, so closing the preview never stops a live call's
processed camera track. The preview's immediate setters persist choices for the next call.

`useLVSHangout` also accepts an optional `cameraEffects` controller with `processStream`,
`outputTrack` and `detach`. It publishes processed camera video, preserves the original
microphone tracks, mirrors camera mute onto the processed track, and detaches at teardown.
Screen sharing uses its independent publisher and is unaffected. Consumers that omit the
controller retain their existing raw-camera behavior.
