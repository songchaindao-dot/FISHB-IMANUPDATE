'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  HMSRoomProvider,
  useHMSActions,
  useHMSStore,
  useVideo,
  useScreenShare,
  selectIsConnectedToRoom,
  selectRoomState,
  HMSRoomState,
  selectPeers,
  selectIsLocalAudioEnabled,
  selectIsLocalVideoEnabled,
  selectScreenShareByPeerID,
} from '@100mslive/react-sdk';
import { useToast } from '@/components/ui/Toast';

interface HMSFishbowlRoomProps {
  fishbowlRoomId: string;
  fishbowlSlug?: string;
  userFid: number;
  userName: string;
  role: 'speaker' | 'listener';
  isHost?: boolean;
  onLeave: () => void;
  authFetch?: (url: string, options?: RequestInit) => Promise<Response>;
  participantCount?: number;
  guestMode?: boolean;
}

/** Renders a screen share track */
function ScreenShareTile({ trackId }: { trackId: string }) {
  const { videoRef } = useVideo({ trackId });
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="w-full h-full object-contain"
    />
  );
}

/** Shows screen share from a peer */
function ScreenShareView({ peerId, peerName }: { peerId: string; peerName: string }) {
  const screenShare = useHMSStore(selectScreenShareByPeerID(peerId));
  if (!screenShare?.id) return null;
  return (
    <div className="mb-4 rounded-xl overflow-hidden bg-black aspect-video max-h-[400px] relative">
      <ScreenShareTile trackId={screenShare.id} />
      <div className="absolute bottom-2 left-2 text-xs bg-black/60 px-2 py-1 rounded text-white">
        {peerName} is sharing screen
      </div>
    </div>
  );
}

function HMSFishbowlRoomInner({ fishbowlRoomId, fishbowlSlug, userFid, userName, role, isHost, onLeave, authFetch, participantCount, guestMode }: HMSFishbowlRoomProps) {
  const hmsActions = useHMSActions();
  const { toast } = useToast();
  // Stable reference to avoid re-triggering effects when authFetch changes identity
  const apiFetchRef = useRef(authFetch || fetch);
  apiFetchRef.current = authFetch || fetch;
  const apiFetch = useCallback((url: string, options?: RequestInit) => apiFetchRef.current(url, options), []);
  const isConnected = useHMSStore(selectIsConnectedToRoom);
  const roomState = useHMSStore(selectRoomState);
  const peers = useHMSStore(selectPeers);
  const isLocalAudioEnabled = useHMSStore(selectIsLocalAudioEnabled);
  const isLocalVideoEnabled = useHMSStore(selectIsLocalVideoEnabled);
  const {
    amIScreenSharing,
    screenSharingPeerId,
    screenSharingPeerName,
    toggleScreenShare,
  } = useScreenShare();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 3;
  const [transcribing, setTranscribing] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const pendingTextRef = useRef('');
  const canUseVideo = !guestMode && (isHost || role === 'speaker');

  const toggleTranscription = useCallback(() => {
    if (transcribing) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setTranscribing(false);
      return;
    }

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast('Speech recognition is not supported in this browser. Try Chrome.', 'error');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = async (event: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = Array.from(event.results) as any[];
      for (const result of results) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transcript = (result[0] as any).transcript.trim();
        if (!transcript) continue;
        if (result.isFinal) {
          const text = pendingTextRef.current + ' ' + transcript;
          pendingTextRef.current = '';
          try {
            await apiFetch('/api/fishbowlz/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                roomId: fishbowlRoomId,
                speakerFid: userFid,
                speakerName: userName,
                speakerRole: role === 'speaker' && isHost ? 'host' : 'speaker',
                text,
                startedAt: new Date().toISOString(),
                source: 'whisper',
              }),
            });
          } catch { /* non-critical */ }
        } else {
          pendingTextRef.current = transcript;
        }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onerror = (e: any) => {
      if (e.error === 'no-speech') return;
      setTranscribing(false);
      recognitionRef.current = null;
    };

    recognition.start();
    setTranscribing(true);
  }, [transcribing, fishbowlRoomId, userFid, userName, role, isHost, apiFetch]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  // Capture initial values in refs so the join effect only runs ONCE per mount.
  // Re-renders from Realtime room updates must NOT cause leave/rejoin.
  const joinParamsRef = useRef({ fishbowlRoomId, fishbowlSlug, userFid, userName, role, isHost, guestMode });
  // Only update ref on first mount — ignore subsequent prop changes

  // Auto-reconnect when HMS connection drops
  useEffect(() => {
    if (roomState === HMSRoomState.Reconnecting) {
      setReconnecting(true);
      reconnectAttempts.current += 1;
    } else if (roomState === HMSRoomState.Connected) {
      if (reconnecting) {
        setReconnecting(false);
        reconnectAttempts.current = 0;
      }
    } else if (
      (roomState === HMSRoomState.Disconnected || roomState === HMSRoomState.Failed) &&
      reconnectAttempts.current > 0
    ) {
      // HMS auto-reconnect failed - try manual reconnect
      if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        const rejoin = async () => {
          try {
            const { fishbowlSlug: slug, userFid: fid, userName: name, role: r, isHost: host } = joinParamsRef.current;
            const hmsRole = host ? 'moderator' : r;
            const roomName = slug ? `fishbowl-${slug}` : undefined;
            const res = await apiFetch('/api/100ms/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: String(fid), role: hmsRole, roomName }),
            });
            if (res.ok) {
              const { token } = await res.json();
              await hmsActions.join({ userName: name, authToken: token });
            }
          } catch {
            // Will retry on next disconnect cycle
          }
        };
        setTimeout(rejoin, 2000 * reconnectAttempts.current);
      } else {
        setError('Connection lost. Please rejoin the room.');
        setReconnecting(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- roomState drives this effect
  }, [roomState]);

  useEffect(() => {
    const { fishbowlRoomId: roomId, fishbowlSlug: slug, userFid: fid, userName: name, role: r, isHost: host, guestMode: guest } = joinParamsRef.current;

    // For guest mode, fid may be 0 - that's OK
    if (!roomId || (!fid && !guest)) return;

    let cancelled = false;
    const joinRoom = async () => {
      setJoining(true);
      setError(null);
      try {
        // In guest mode, always request listener role and use plain fetch (no auth)
        const hmsRole = guest ? 'listener' : (host ? 'moderator' : r);
        const roomName = slug ? `fishbowl-${slug}` : undefined;
        const fetchFn = guest ? fetch : apiFetch;
        const res = await fetchFn('/api/100ms/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: guest ? `guest-${Math.random().toString(36).slice(2, 8)}` : String(fid),
            role: hmsRole,
            roomName,
            ...(guest ? { anonymous: true } : {}),
          }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Token request failed (${res.status})`);
        }
        const { token } = await res.json();
        if (cancelled) return;
        await hmsActions.join({ userName: name, authToken: token });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to connect to audio');
        }
      } finally {
        if (!cancelled) setJoining(false);
      }
    };

    joinRoom();

    return () => {
      cancelled = true;
      hmsActions.leave().catch(() => {});
    };
  }, [hmsActions, apiFetch]);

  const leaveRoom = async () => {
    await hmsActions.leave();
    onLeave();
  };

  const retryJoin = () => {
    setError(null);
    setJoining(true);
    const hmsRole = guestMode ? 'listener' : (isHost ? 'moderator' : role);
    const roomName = fishbowlSlug ? `fishbowl-${fishbowlSlug}` : undefined;
    const fetchFn = guestMode ? fetch : apiFetch;
    fetchFn('/api/100ms/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: guestMode ? `guest-${Math.random().toString(36).slice(2, 8)}` : String(userFid),
        role: hmsRole,
        roomName,
        ...(guestMode ? { anonymous: true } : {}),
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Token request failed (${res.status})`);
        }
        return res.json();
      })
      .then(({ token }) => hmsActions.join({ userName, authToken: token }))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to connect'))
      .finally(() => setJoining(false));
  };

  const toggleMute = async () => {
    await hmsActions.setLocalAudioEnabled(!isLocalAudioEnabled);
  };

  const toggleVideo = async () => {
    if (!canUseVideo) {
      toast('Camera is only available for hosts and speakers in this room.', 'info');
      return;
    }

    try {
      await hmsActions.setLocalVideoEnabled(!isLocalVideoEnabled);
    } catch (err) {
      console.error('Camera toggle failed:', err);
      toast(
        'Camera is not available. Your role may not have video permission, or camera access was denied.',
        'error'
      );
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-3 px-4">
        <p className="text-red-400 text-sm text-center">{error}</p>
        <p className="text-gray-500 text-xs text-center max-w-xs">
          Check that your browser has microphone permission enabled. If the problem persists, try refreshing the page.
        </p>
        <button
          onClick={() => {
            reconnectAttempts.current = 0;
            retryJoin();
          }}
          className="px-4 py-1.5 bg-gold text-navy rounded-lg text-xs font-medium hover:bg-[#d4941f] transition-colors"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  if (joining) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400">
        Joining audio room...
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400">
        Connecting to audio...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gold opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-gold" />
          </span>
          <span className="text-white text-sm font-medium">Live</span>
          <span className="text-gray-500 text-xs">{participantCount ?? peers.length} in room</span>
        </div>
        <div className="flex gap-2">
          {!guestMode && (isHost || role === 'speaker') && (
            <button
              onClick={toggleTranscription}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                transcribing
                  ? 'bg-red-600/20 text-red-400 border border-red-600/30'
                  : 'bg-white/5 text-gray-400 hover:text-white'
              }`}
              title={transcribing ? 'Stop transcription' : 'Start live transcription'}
            >
              {transcribing ? '⏹ Live' : '🎤 Transcribe'}
            </button>
          )}
          {!guestMode && (
            <>
              <button
                onClick={toggleMute}
                className={`p-2 rounded-full transition-colors ${
                  isLocalAudioEnabled
                    ? 'bg-gold/20 text-gold'
                    : 'bg-red-500/20 text-red-400'
                }`}
                aria-label={isLocalAudioEnabled ? 'Mute microphone' : 'Unmute microphone'}
                title={isLocalAudioEnabled ? 'Mute' : 'Unmute'}
              >
                {isLocalAudioEnabled ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5.29"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                )}
              </button>
              {canUseVideo && (
                <button
                  onClick={toggleVideo}
                  className={`p-2 rounded-full transition-colors ${
                    isLocalVideoEnabled
                      ? 'bg-gold/20 text-gold'
                      : 'bg-red-500/20 text-red-400'
                  }`}
                  aria-label={isLocalVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
                  title={isLocalVideoEnabled ? 'Camera off' : 'Camera on'}
                >
                  {isLocalVideoEnabled ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
                  )}
                </button>
              )}
              {toggleScreenShare && (
                <button
                  onClick={() => toggleScreenShare()}
                  className={`p-2 rounded-full transition-colors ${
                    amIScreenSharing
                      ? 'bg-gold text-navy'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                  aria-label={amIScreenSharing ? 'Stop sharing screen' : 'Share screen'}
                  title={amIScreenSharing ? 'Stop sharing' : 'Share screen'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
                </button>
              )}
            </>
          )}
          <button
            onClick={leaveRoom}
            className="px-3 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-xs font-medium"
          >
            Leave
          </button>
        </div>
      </div>

      {/* Reconnecting banner */}
      {reconnecting && (
        <div className="px-4 py-2 bg-gold/10 border-b border-gold/20 flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gold animate-pulse" />
          <span className="text-xs text-gold">Reconnecting to audio...</span>
        </div>
      )}

      {/* Screen Share */}
      {screenSharingPeerId && (
        <div className="p-4">
          <ScreenShareView peerId={screenSharingPeerId} peerName={screenSharingPeerName || 'Someone'} />
        </div>
      )}
    </div>
  );
}

export function HMSFishbowlRoom(props: HMSFishbowlRoomProps) {
  return (
    <HMSRoomProvider>
      <HMSFishbowlRoomInner {...props} />
    </HMSRoomProvider>
  );
}
