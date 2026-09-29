import { describe, it, expect, jest } from '@jest/globals';
import { createElement } from 'react';
import { conversationCallDockProps, type ConversationCallDockState } from '../../../src/client/video/conversationCallDockProps';
import type { ConversationCallParticipant } from '../../../src/client/video/conversationCallTypes';

const person = (p: Partial<ConversationCallParticipant> & { id: string }): ConversationCallParticipant => ({
  userId: p.id, displayName: p.id, isLocal: false, state: 'in-call', audioOn: true, cameraOn: true, screenSharing: false,
  participantId: p.id, stream: null, screenStream: null, ...p,
});

function state(over: Partial<ConversationCallDockState> = {}): ConversationCallDockState {
  return {
    phase: 'live',
    call: { participants: [person({ id: 'me', displayName: 'You', isLocal: true }), person({ id: 'bob', displayName: 'Bob Stone' })], participantCount: 2 },
    error: null,
    callingTo: null,
    elapsedMs: 65_000,
    activeSpeakerId: null,
    self: { audioOn: true, cameraOn: true, screenSharing: false },
    devices: {
      prefs: { microphoneId: 'mic-2' },
      set: jest.fn(),
      list: {
        microphones: [{ deviceId: 'mic-2', label: 'Headset', kind: 'audioinput' }],
        cameras: [{ deviceId: 'cam-1', label: 'FaceTime', kind: 'videoinput' }],
        permission: { microphone: 'granted', camera: 'granted' },
      },
    },
    toggleMic: jest.fn(), toggleCamera: jest.fn(), toggleScreenShare: jest.fn(),
    leave: jest.fn(async () => undefined), rejoin: jest.fn(async () => undefined),
    ...over,
  };
}

const ui = { title: 'Bob Stone', onOpenPeople: jest.fn(), onOpenSettings: jest.fn(), tile: (p: ConversationCallParticipant) => createElement('video', { 'data-id': p.id }) };

describe('conversationCallDockProps', () => {
  it('draws nothing while idle or ringing', () => {
    expect(conversationCallDockProps(state({ phase: 'idle' }), ui)).toBeNull();
    expect(conversationCallDockProps(state({ phase: 'ringing' }), ui)).toBeNull();
  });

  it('maps a live call: tiles, clock, devices, speaker ring never on you', () => {
    const s = state({ activeSpeakerId: 'me' });
    const d = conversationCallDockProps(s, { ...ui, peopleOpen: true, compact: true })!;
    expect(d).toMatchObject({ title: 'Bob Stone', phase: 'active', elapsedMs: 65_000, participantCount: 2, localParticipantId: 'me', activeSpeakerId: null, peopleOpen: true, compact: true });
    expect(d.participants.map((p) => [p.userId, p.isLocal, !!p.videoElement])).toEqual([['me', true, true], ['bob', false, true]]);
    expect(d.mic).toMatchObject({ on: true, selectedDeviceId: 'mic-2', permission: 'granted' });
    d.camera.onSelectDevice('cam-1');
    expect(s.devices.set).toHaveBeenCalledWith({ microphoneId: 'mic-2', cameraId: 'cam-1' });
    expect(conversationCallDockProps(state({ activeSpeakerId: 'bob' }), ui)!.activeSpeakerId).toBe('bob');
    expect(conversationCallDockProps(state({ activeSpeakerId: 'bob' }), { ...ui, activeSpeakerId: null })!.activeSpeakerId).toBeNull();
  });

  it('calling: no clock, the callee named, invitees are not tiles', () => {
    const d = conversationCallDockProps(state({
      phase: 'calling', callingTo: 'Bob Stone',
      call: { participants: [person({ id: 'me', isLocal: true }), person({ id: 'bob', state: 'ringing' })], participantCount: 1 },
    }), ui)!;
    expect(d).toMatchObject({ phase: 'calling', callingTo: 'Bob Stone', elapsedMs: null, participantCount: 1 });
    expect(d.participants).toHaveLength(1);
  });

  it('a remote screen share goes in their tile; their camera carries the audio; Share names them', () => {
    const screen = createElement('video', { 'data-screen': true });
    const s = state({ call: { participants: [person({ id: 'me', isLocal: true }), person({ id: 'bob', displayName: 'Bob Stone', screenSharing: true })], participantCount: 2 } });
    const d = conversationCallDockProps(s, { ...ui, screenTile: (p) => (p.id === 'bob' ? screen : undefined) })!;
    const bob = d.participants[1]!;
    expect(bob.videoElement).toBe(screen);
    expect(bob.audioElement).toBeDefined();
    expect(bob).toMatchObject({ screenSharing: true, cameraOn: true });
    expect(d.screenShare.disabledReason).toBe('Bob Stone is sharing');
  });

  it('failed → the Lost-the-call banner with Rejoin and Dismiss', () => {
    const s = state({ phase: 'failed', error: { message: 'SFU went away' } });
    const d = conversationCallDockProps(s, ui)!;
    expect(d.phase).toBe('error');
    expect(d.error).toMatchObject({ title: 'Lost the call', message: 'SFU went away', retryLabel: 'Rejoin' });
    d.error!.onRetry();
    d.onDismiss!();
    expect(s.rejoin).toHaveBeenCalled();
    expect(s.leave).toHaveBeenCalled();
  });

  it('camera menu extras pass through', () => {
    const onSelect = jest.fn();
    const d = conversationCallDockProps(state(), { ...ui, cameraMenuItems: [{ label: 'Blur background…', onSelect }] })!;
    expect(d.camera.extraItems).toEqual([{ label: 'Blur background…', onSelect }]);
  });
});
