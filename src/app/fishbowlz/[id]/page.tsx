'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { TranscriptInput } from '@/components/spaces/TranscriptInput';
import { FishbowlChat } from '@/components/spaces/FishbowlChat';
import { Reactions } from '@/components/fishbowlz/Reactions';
import { TipButton } from '@/components/fishbowlz/TipButton';
import { useToast, ToastProvider } from '@/components/ui/Toast';
import dynamic from 'next/dynamic';
import { ShareModal } from '@/components/shared/ShareModal';
import { getSupabaseBrowser } from '@/lib/db/supabase';

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return (value as T) ?? fallback;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SpeakerTime({ joinedAt }: { joinedAt: string }) {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    const update = () => {
      const seconds = Math.floor((Date.now() - new Date(joinedAt).getTime()) / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      setElapsed(`${mins}:${secs.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [joinedAt]);

  return <span className="text-xs text-gray-500 font-mono">{elapsed}</span>;
}

function Countdown({ targetDate }: { targetDate: string }) {
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    const update = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining('Starting soon...');
        return;
      }
      const hours = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      if (hours > 0) {
        setRemaining(`${hours}h ${mins}m ${secs}s`);
      } else {
        setRemaining(`${mins}m ${secs}s`);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [targetDate]);

  return <span className="text-2xl font-mono font-bold text-gold">{remaining}</span>;
}

const HMSFishbowlRoom = dynamic(
  () => import('@/components/spaces/HMSFishbowlRoom').then((m) => m.HMSFishbowlRoom),
  { ssr: false }
);

interface Speaker {
  fid: number;
  username: string;
  joinedAt: string;
}

interface FishbowlRoom {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  host_fid: number;
  host_name: string;
  host_username: string;
  state: string;
  hot_seat_count: number;
  rotation_enabled: boolean;
  rotation_interval_ms?: number | null;
  current_speakers: Speaker[];
  current_listeners: Speaker[];
  hand_raises?: Array<{ fid: number; username: string; joinedAt: string }>;
  audio_source_type: string | null;
  audio_source_url: string | null;
  gate_type?: string;
  gate_config?: Record<string, unknown>;
  created_at: string;
  scheduled_at?: string | null;
  ai_summary?: string | null;
}

interface TranscriptSegment {
  id: string;
  speaker_name: string;
  speaker_role: string;
  text: string;
  started_at: string;
}

type TranscriptMode = 'full' | 'summary' | 'highlights' | 'decisions' | 'actions';
type MemoryMode = 'short' | 'full' | 'decisions' | 'actions' | 'moments';
type BotState = 'invited' | 'listening' | 'live' | 'processing' | 'ready';
type RoomMode = 'discussion' | 'meeting' | 'classroom' | 'concert' | 'radio' | 'listening_party';

function timestampLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Inner component (needs ToastProvider above it) ──────────────────────────

function FishbowlRoomPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomId = params.id as string;
  const inviteParam = searchParams.get('invite');
  const { user, loading: authLoading, authFetch } = useAuth();
  const { toast } = useToast();

  const [room, setRoom] = useState<FishbowlRoom | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioJoined, setAudioJoined] = useState(false);
  const [joinedRole, setJoinedRole] = useState<'speaker' | 'listener'>('listener');
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [gateError, setGateError] = useState<{ message: string; details?: string } | null>(null);
  const [showEndedOverlay, setShowEndedOverlay] = useState(false);
  const [endedCountdown, setEndedCountdown] = useState(5);
  const endedRoomRef = useRef<FishbowlRoom | null>(null);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const transcriptBottomRef = useRef<HTMLDivElement>(null);
  const [showAllTranscripts, setShowAllTranscripts] = useState(false);
  const [recap, setRecap] = useState<string | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [guestMode, setGuestMode] = useState(false);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>('short');
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>('full');
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [botState, setBotState] = useState<BotState>('invited');
  const [botConsent, setBotConsent] = useState(true);
  const [botAdminLock, setBotAdminLock] = useState(true);
  const [roomMode, setRoomMode] = useState<RoomMode>('discussion');
  const [externalAudioUrl, setExternalAudioUrl] = useState('');
  const [externalQueue, setExternalQueue] = useState<string[]>([]);
  const [externalPlaying, setExternalPlaying] = useState(false);
  const [externalLoading, setExternalLoading] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState('');
  const [archiveFilter, setArchiveFilter] = useState<'all' | 'summary' | 'decisions' | 'actions' | 'moments'>('all');
  // Stable guest username so it doesn't change on re-render
  const guestNameRef = useRef(`Guest-${Math.floor(1000 + Math.random() * 9000)}`);

  const transcriptInsights = useMemo(() => {
    const lines = transcripts.map((t) => normalizeText(t.text)).filter(Boolean);
    const fullText = lines.join(' ');
    const sentences = fullText.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 20);

    const summary = recap || room?.ai_summary || (sentences.slice(0, 4).join(' ') || 'Summary is generating as the room continues.');
    const highlights = transcripts
      .filter((t) => /\!|\?|important|notable|highlight|key|milestone|launch|vote/i.test(t.text))
      .slice(-8);
    const decisions = transcripts
      .filter((t) => /(decide|decision|agreed|approved|ship|final|resolved|vote)/i.test(t.text))
      .slice(-8);
    const actions = transcripts
      .filter((t) => /(action|todo|owner|follow up|next step|by friday|by monday|deadline|assign)/i.test(t.text))
      .slice(-8);

    const keyMoments = transcripts
      .filter((t) => /(applause|laugh|cheer|reaction|quote|insight|breakthrough|milestone)/i.test(t.text))
      .slice(-8);

    return {
      summary,
      highlights: highlights.length ? highlights : transcripts.slice(-6),
      decisions: decisions.length ? decisions : transcripts.slice(-4),
      actions: actions.length ? actions : transcripts.slice(-4),
      keyMoments: keyMoments.length ? keyMoments : transcripts.slice(-4),
    };
  }, [transcripts, recap, room?.ai_summary]);

  const transcriptModeItems = useMemo(() => {
    if (transcriptMode === 'summary') {
      return [{ id: 'summary', speaker_name: 'AI Memory', speaker_role: 'summary', text: transcriptInsights.summary, started_at: new Date().toISOString() }];
    }
    if (transcriptMode === 'highlights') return transcriptInsights.highlights;
    if (transcriptMode === 'decisions') return transcriptInsights.decisions;
    if (transcriptMode === 'actions') return transcriptInsights.actions;
    return transcripts;
  }, [transcriptMode, transcriptInsights, transcripts]);

  const filteredTranscriptItems = useMemo(() => {
    const q = transcriptQuery.trim().toLowerCase();
    if (!q) return transcriptModeItems;
    return transcriptModeItems.filter((t) =>
      [t.speaker_name, t.speaker_role, t.text].join(' ').toLowerCase().includes(q)
    );
  }, [transcriptModeItems, transcriptQuery]);

  const archiveEntries = useMemo(() => {
    const base = [
      { id: 'sum', type: 'summary', title: 'Session Summary', text: transcriptInsights.summary },
      ...transcriptInsights.decisions.map((d) => ({ id: `d-${d.id}`, type: 'decisions', title: `Decision by ${d.speaker_name}`, text: d.text })),
      ...transcriptInsights.actions.map((a) => ({ id: `a-${a.id}`, type: 'actions', title: `Action item from ${a.speaker_name}`, text: a.text })),
      ...transcriptInsights.keyMoments.map((m) => ({ id: `m-${m.id}`, type: 'moments', title: `Moment: ${m.speaker_name}`, text: m.text })),
    ];
    return base.filter((entry) => {
      const typeMatch = archiveFilter === 'all' || entry.type === archiveFilter;
      const queryMatch = !archiveQuery.trim() || `${entry.title} ${entry.text}`.toLowerCase().includes(archiveQuery.trim().toLowerCase());
      return typeMatch && queryMatch;
    });
  }, [transcriptInsights, archiveFilter, archiveQuery]);

  const isHost = user?.fid === room?.host_fid;
  const isSpeaker = room?.current_speakers?.some((s) => s.fid === user?.fid);
  const isListener = room?.current_listeners?.some((l) => l.fid === user?.fid);
  const hotSeatFull = (room?.current_speakers?.length || 0) >= (room?.hot_seat_count || 0);

  const isChrome = typeof navigator !== 'undefined' && /Chrome/.test(navigator.userAgent) && !/Edge|OPR/.test(navigator.userAgent);
  const showGuidance = !guidanceDismissed && !isSpeaker && !isListener && room?.state === 'active';
  const guidanceMessage = !isChrome
    ? 'Live transcription works best in Chrome. Audio works in all browsers.'
    : 'Allow microphone access when prompted to join as a speaker.';

  const fetchRoom = useCallback(async () => {
    try {
      const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`);
      if (!res.ok) throw new Error('Room not found');
      const data = await res.json();
      // Parse JSONB strings from Supabase
      data.current_speakers = parseJsonb(data.current_speakers, []);
      data.current_listeners = parseJsonb(data.current_listeners, []);
      data.hand_raises = parseJsonb(data.hand_raises, []);

      if (data.state === 'ended') {
        setAudioJoined(false);
        // Only show interstitial if the user was actively participating when the room ended.
        // If navigating directly to an ended room URL, show the transcript archive instead.
        setRoom((prev) => {
          if (prev && prev.state === 'active') {
            const wasParticipating =
              prev.current_speakers?.some((s) => s.fid === user?.fid) ||
              prev.current_listeners?.some((l) => l.fid === user?.fid);
            if (wasParticipating) {
              endedRoomRef.current = data;
              setShowEndedOverlay(true);
            }
          }
          return data;
        });
        return;
      }

      setRoom(data);
    } catch {
      setError('Room not found');
    } finally {
      setLoading(false);
    }
  }, [roomId, user?.fid, authFetch]);

  const fetchTranscripts = useCallback(async () => {
    if (!room?.id) return;
    try {
      const res = await authFetch(`/api/fishbowlz/transcripts?roomId=${room.id}&limit=50`);
      if (res.ok) {
        const data = await res.json();
        setTranscripts(data.transcripts || []);
      }
    } catch {
      // Non-critical
    }
  }, [room?.id, authFetch]);

  const fetchRecap = useCallback(async () => {
    if (!room?.id) return;
    setRecapLoading(true);
    try {
      const res = await authFetch('/api/fishbowlz/recap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: room.id }),
      });
      const data = await res.json();
      if (data.recap) setRecap(data.recap);
    } catch {
      setRecap('Could not generate recap. Try again later.');
    } finally {
      setRecapLoading(false);
    }
  }, [room?.id, authFetch]);

  // Initial fetch + Realtime subscription for room changes
  useEffect(() => {
    if (authLoading) return;
    if (!roomId) return;

    // Initial fetch
    fetchRoom();

    const supabase = getSupabaseBrowser();

    // Subscribe to room changes via Realtime.
    // roomId from URL params may be a slug, so we filter on both id and slug columns.
    // Supabase Realtime only supports one filter per subscription, so we use two channels.
    const channelById = supabase
      .channel(`fishbowl-room-id-${roomId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'fishbowl_rooms',
        filter: `id=eq.${roomId}`,
      }, (payload) => {
        if (payload.new) {
          const data = payload.new as Record<string, unknown>;
          data.current_speakers = parseJsonb(data.current_speakers, []);
          data.current_listeners = parseJsonb(data.current_listeners, []);
          data.hand_raises = parseJsonb(data.hand_raises, []);
          if (data.state === 'ended') {
            setAudioJoined(false);
            setRoom((prev) => {
              if (prev && prev.state === 'active') {
                const wasParticipating =
                  prev.current_speakers?.some((s) => s.fid === user?.fid) ||
                  prev.current_listeners?.some((l) => l.fid === user?.fid);
                if (wasParticipating) {
                  endedRoomRef.current = data as unknown as FishbowlRoom;
                  setShowEndedOverlay(true);
                }
              }
              return data as unknown as FishbowlRoom;
            });
          } else {
            setRoom(data as unknown as FishbowlRoom);
          }
        }
      })
      .subscribe();

    const channelBySlug = supabase
      .channel(`fishbowl-room-slug-${roomId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'fishbowl_rooms',
        filter: `slug=eq.${roomId}`,
      }, (payload) => {
        if (payload.new) {
          const data = payload.new as Record<string, unknown>;
          data.current_speakers = parseJsonb(data.current_speakers, []);
          data.current_listeners = parseJsonb(data.current_listeners, []);
          data.hand_raises = parseJsonb(data.hand_raises, []);
          if (data.state === 'ended') {
            setAudioJoined(false);
            setRoom((prev) => {
              if (prev && prev.state === 'active') {
                const wasParticipating =
                  prev.current_speakers?.some((s) => s.fid === user?.fid) ||
                  prev.current_listeners?.some((l) => l.fid === user?.fid);
                if (wasParticipating) {
                  endedRoomRef.current = data as unknown as FishbowlRoom;
                  setShowEndedOverlay(true);
                }
              }
              return data as unknown as FishbowlRoom;
            });
          } else {
            setRoom(data as unknown as FishbowlRoom);
          }
        }
      })
      .subscribe();

    // Fallback poll every 30s in case realtime misses something
    const fallback = setInterval(fetchRoom, 30000);

    return () => {
      supabase.removeChannel(channelById);
      supabase.removeChannel(channelBySlug);
      clearInterval(fallback);
    };
  }, [roomId, authLoading, fetchRoom, user?.fid]);

  // Realtime subscription for transcript inserts
  useEffect(() => {
    if (authLoading) return;
    if (!room?.id) return;
    if (room.state === 'ended') return;

    // Initial fetch
    fetchTranscripts();

    const supabase = getSupabaseBrowser();

    const channel = supabase
      .channel(`fishbowl-transcripts-${room.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'fishbowl_transcripts',
        filter: `room_id=eq.${room.id}`,
      }, (payload) => {
        if (payload.new) {
          setTranscripts(prev => [...prev, payload.new as TranscriptSegment]);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [room?.id, room?.state, authLoading, fetchTranscripts]);

  // Heartbeat: keep user presence alive (every 45s)
  useEffect(() => {
    if (!user || !roomId || (!isSpeaker && !isListener)) return;

    const sendHeartbeat = () => {
      authFetch(`/api/fishbowlz/rooms/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'heartbeat', fid: user.fid }),
      }).catch(() => {});
    };

    sendHeartbeat();
    const heartbeatInterval = setInterval(sendHeartbeat, 45_000);

    return () => clearInterval(heartbeatInterval);
  }, [user, roomId, isSpeaker, isListener, authFetch]);

  // beforeunload: fire a leave request when the tab is closed
  useEffect(() => {
    if (!user || !roomId || (!isSpeaker && !isListener)) return;

    const handleBeforeUnload = () => {
      const action = isSpeaker ? 'leave_speaker' : 'leave_listener';
      fetch(`/api/fishbowlz/rooms/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, fid: user.fid }),
        keepalive: true,
      }).catch(() => {});
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [user, roomId, isSpeaker, isListener]);

  // Auto-rotation timer
  useEffect(() => {
    if (!isHost || !room?.rotation_interval_ms || room.state !== 'active') return;
    if (!room.current_speakers || room.current_speakers.length === 0) return;

    const checkRotation = () => {
      const oldest = room.current_speakers[0];
      if (!oldest) return;
      const seatedMs = Date.now() - new Date(oldest.joinedAt).getTime();
      if (seatedMs >= room.rotation_interval_ms!) {
        // Auto-rotate: kick the oldest speaker
        authFetch(`/api/fishbowlz/rooms/${roomId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'kick_speaker', targetFid: oldest.fid }),
        }).then(() => fetchRoom()).catch(() => {});
      }
    };

    const interval = setInterval(checkRotation, 10000); // check every 10s
    return () => clearInterval(interval);
  }, [isHost, room?.rotation_interval_ms, room?.state, room?.current_speakers, roomId, fetchRoom, authFetch]);

  // Check if guidance was previously dismissed
  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('fishbowlz-guidance-dismissed')) {
      setGuidanceDismissed(true);
    }
  }, []);

  // Auto-scroll transcript to bottom when new transcripts arrive
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  // Countdown for ended room interstitial
  useEffect(() => {
    if (!showEndedOverlay) return;
    if (endedCountdown <= 0) {
      router.push('/fishbowlz');
      return;
    }
    const timer = setTimeout(() => setEndedCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [showEndedOverlay, endedCountdown, router]);

  const endRoom = async () => {
    const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end_room' }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      toast(errData.error || 'Failed to end room', 'error');
      return;
    }
    router.push('/fishbowlz');
  };

  const joinAsSpeaker = async () => {
    if (!user || joining || audioJoined) return;
    setJoining(true);
    setGateError(null);
    try {
      const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join_speaker', fid: user.fid, username: user.username, invite: inviteParam || undefined }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 403 && errData.reason) {
          const score = errData.score ? ` Your score: ${errData.score}.` : '';
          setGateError({
            message: errData.error || 'You don\'t meet the requirements to join.',
            details: errData.reason + score,
          });
        } else {
          toast(errData.error || 'Failed to join', 'error');
        }
        return;
      }
      await fetchRoom();
      setJoinedRole('speaker');
      setAudioJoined(true);
    } finally {
      setJoining(false);
    }
  };

  const joinAsListener = async () => {
    if (!user || joining || audioJoined) return;
    setJoining(true);
    try {
      const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join_listener', fid: user.fid, username: user.username, invite: inviteParam || undefined }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        toast(errData.error || 'Failed to join', 'error');
        return;
      }
      await fetchRoom();
      setJoinedRole('listener');
      setAudioJoined(true);
    } finally {
      setJoining(false);
    }
  };

  const rotateIn = async () => {
    if (!user || joining) return;
    setJoining(true);
    try {
      await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rotate_in', listenerFid: user.fid, listenerUsername: user.username }),
      });
      await fetchRoom();
    } finally {
      setJoining(false);
    }
  };

  const leave = async () => {
    if (!user) return;
    const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave_speaker', fid: user.fid }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      toast(errData.error || 'Failed to leave', 'error');
      return;
    }
    await fetchRoom();
    setAudioJoined(false);
  };

  const generateInvite = async () => {
    if (!room || inviteLoading) return;
    setInviteLoading(true);
    try {
      const res = await authFetch('/api/fishbowlz/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: room.id }),
      });
      if (res.ok) {
        const data = await res.json();
        setInviteCode(data.code);
      } else {
        toast('Failed to generate invite', 'error');
      }
    } catch {
      toast('Failed to generate invite', 'error');
    } finally {
      setInviteLoading(false);
    }
  };

  const copyCurrentTranscript = async () => {
    const text = filteredTranscriptItems
      .map((item) => `[${timestampLabel(item.started_at)}] ${item.speaker_name}: ${item.text}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text || 'No transcript content available yet.');
      toast('Transcript copied', 'success');
    } catch {
      toast('Copy failed', 'error');
    }
  };

  const downloadJsonExport = () => {
    if (!room) {
      toast('Room details are not available yet', 'error');
      return;
    }

    const payload = {
      room: {
        id: room.id,
        slug: room.slug,
        title: room.title,
        mode: roomMode,
        host: room.host_username,
        createdAt: room.created_at,
      },
      outputs: {
        summary: transcriptInsights.summary,
        decisions: transcriptInsights.decisions,
        actions: transcriptInsights.actions,
        highlights: transcriptInsights.highlights,
        fullTranscript: transcripts,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${room.slug || room.id}-transcript.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openPdfReadyView = () => {
    if (!room) {
      toast('Room details are not available yet', 'error');
      return;
    }

    const popup = window.open('', '_blank');
    if (!popup) {
      toast('Please allow popups for PDF view', 'error');
      return;
    }
    const body = filteredTranscriptItems
      .map((item) => `<p><strong>[${timestampLabel(item.started_at)}] ${item.speaker_name}</strong>: ${item.text}</p>`)
      .join('');
    popup.document.write(`
      <html>
        <head><title>${room.title} Transcript</title></head>
        <body style="font-family: Inter, Arial, sans-serif; padding: 24px;">
          <h1>${room.title}</h1>
          <p>Export mode: ${transcriptMode}</p>
          ${body || '<p>No transcript content yet.</p>'}
        </body>
      </html>
    `);
    popup.document.close();
    popup.focus();
    popup.print();
  };

  const memoryOutput = useMemo(() => {
    if (memoryMode === 'full') return transcriptInsights.summary;
    if (memoryMode === 'decisions') {
      return transcriptInsights.decisions.map((d) => `- ${d.text}`).join('\n') || 'No decisions captured yet.';
    }
    if (memoryMode === 'actions') {
      return transcriptInsights.actions.map((a) => `- ${a.text}`).join('\n') || 'No action items captured yet.';
    }
    if (memoryMode === 'moments') {
      return transcriptInsights.keyMoments.map((m) => `- ${m.text}`).join('\n') || 'No key moments captured yet.';
    }
    return transcriptInsights.summary.split('. ').slice(0, 2).join('. ');
  }, [memoryMode, transcriptInsights]);

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-navy text-white flex items-center justify-center">
        <div className="text-gray-400">Loading fishbowl...</div>
      </div>
    );
  }

  if (error || !room) {
    return (
      <div className="min-h-screen bg-navy text-white flex flex-col items-center justify-center">
        <p className="text-gray-400 mb-4">{error || 'Room not found'}</p>
        <button onClick={() => router.push('/fishbowlz')} className="text-gold hover:underline">
          ← Back to rooms
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-navy text-white flex flex-col">
      {/* Header */}
      <div className="border-b border-white/10 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => router.push('/fishbowlz')} className="text-gray-400 hover:text-white shrink-0 p-1" aria-label="Back to rooms">
            ←
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg sm:text-xl font-bold truncate" title={room.title}>{room.title}</h1>
              {room.gate_type && room.gate_type !== 'open' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-gray-400 shrink-0">
                  {room.gate_type === 'farcaster' ? 'FC Only' :
                   room.gate_type === 'invite' ? 'Invite Only' :
                   room.gate_type === 'token' ? 'Token Gated' : ''}
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-gray-400">by @{room.host_username}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowShare(true)}
            className="text-xs px-2 py-1 rounded-full bg-white/10 text-gray-300 hover:text-white hover:bg-white/20 transition-colors"
            title="Share room"
          >
            Share
          </button>
          {isHost && room.gate_type === 'invite' && (
            <button
              onClick={generateInvite}
              disabled={inviteLoading}
              className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-gold/10 text-gold hover:bg-gold/20 transition-colors disabled:opacity-50"
            >
              {inviteLoading ? '...' : 'Invite'}
            </button>
          )}
          {room.state === 'ended' && (
            <a
              href={`/api/fishbowlz/export?roomId=${room.id}`}
              download
              className="text-xs px-2 py-1 rounded-full bg-white/10 text-gray-300 hover:text-white hover:bg-white/20 transition-colors"
              title="Download transcript"
            >
              📥 Export
            </a>
          )}
          <span className={`text-xs px-2 py-1 rounded-full ${
            room.state === 'active'
              ? 'bg-gold/20 text-gold'
              : 'bg-gray-600/20 text-gray-400'
          }`}>
            {room.state}
          </span>
          <span className="text-xs text-gray-500">🔴 {room.hot_seat_count} seats</span>
          {isHost && room.state === 'active' && (
            <button
              onClick={() => setShowEndConfirm(true)}
              className="text-xs px-2 py-1 rounded-full bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30 transition-colors"
            >
              End Room
            </button>
          )}
        </div>
      </div>

      {inviteCode && (
        <div className="px-4 sm:px-6 py-2 border-b border-white/10 bg-white/2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
            <span className="text-xs text-gray-400 truncate flex-1">
              fishbowlz.com/fishbowlz/{room.slug}?invite={inviteCode}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(`https://fishbowlz.com/fishbowlz/${room.slug}?invite=${inviteCode}`);
                toast('Invite link copied!', 'success');
              }}
              className="text-xs text-gold hover:text-[#d4941f] shrink-0"
            >
              Copy
            </button>
            <button
              onClick={() => setInviteCode(null)}
              className="text-xs text-gray-500 hover:text-gray-300 shrink-0"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showGuidance && (
        <div className="bg-gold/10 border-b border-gold/20 px-4 py-2 flex items-center justify-between gap-2">
          <p className="text-xs text-gold">💡 {guidanceMessage}</p>
          <button
            onClick={() => {
              setGuidanceDismissed(true);
              localStorage.setItem('fishbowlz-guidance-dismissed', '1');
            }}
            className="text-gold/50 hover:text-gold text-xs shrink-0"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Main Stage — Hot Seat + Audio */}
        <div className="flex-1 p-4 sm:p-6">
          {/* Scheduled — countdown + start now */}
          {room.state === 'scheduled' && (
            <div className="mb-6 p-6 bg-[#1a2a4a] rounded-xl border border-blue-500/20 text-center">
              <p className="text-xs text-blue-400 uppercase tracking-wider font-semibold mb-2">Scheduled</p>
              {room.scheduled_at && (
                <>
                  <Countdown targetDate={room.scheduled_at} />
                  <p className="text-sm text-gray-400 mt-2">
                    {new Date(room.scheduled_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at{' '}
                    {new Date(room.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </p>
                </>
              )}
              {isHost && (
                <button
                  onClick={async () => {
                    await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'start_room', username: user?.username }),
                    });
                    await fetchRoom();
                  }}
                  className="mt-4 bg-gold text-navy font-bold px-8 py-3 rounded-full hover:bg-[#d4941f] transition-all hover:shadow-[0_0_30px_rgba(245,166,35,0.3)]"
                >
                  Start Now
                </button>
              )}
              {!isHost && (
                <p className="mt-4 text-sm text-gray-500">Waiting for the host to start...</p>
              )}
            </div>
          )}

          {/* Ended banner */}
          {room.state === 'ended' && (
            <div className="mb-4 p-3 bg-gray-800/50 rounded-lg border border-white/8 text-center">
              <p className="text-gray-400 text-sm">This fishbowl has ended</p>
            </div>
          )}

          {room.state === 'ended' && room.ai_summary && (
            <div className="mb-4 p-4 bg-[#1a2a4a] rounded-xl border border-white/10">
              <h3 className="text-xs font-semibold text-gold uppercase tracking-wider mb-2">AI Summary</h3>
              <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">{room.ai_summary}</p>
            </div>
          )}

          {room.state === 'active' && (
            <>
              {/* HMS Audio — supports both authenticated users and anonymous guest listeners */}
              {audioJoined && (user || guestMode) && (
                <div className="mb-6 rounded-xl overflow-hidden border border-white/10">
                  <HMSFishbowlRoom
                    fishbowlRoomId={room.id}
                    fishbowlSlug={room.slug}
                    userFid={user?.fid || 0}
                    userName={user?.displayName || user?.username || guestNameRef.current}
                    role={joinedRole}
                    isHost={isHost}
                    onLeave={() => {
                      setAudioJoined(false);
                      setGuestMode(false);
                    }}
                    authFetch={guestMode ? undefined : authFetch}
                    participantCount={(room.current_speakers?.length || 0) + (room.current_listeners?.length || 0)}
                    guestMode={guestMode}
                  />
                </div>
              )}

              {/* Transcript Input — for speakers to add what they said */}
              {isSpeaker && (
                <div className="mb-6 p-4 bg-[#1a2a4a] rounded-xl border border-white/10">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">📝 Add to transcript</p>
                  <TranscriptInput
                    roomId={room.id}
                    speakerRole={isHost ? 'host' : 'speaker'}
                    onTranscriptAdded={() => fetchTranscripts()}
                    authFetch={authFetch}
                  />
                </div>
              )}
            </>
          )}

          <div className="mb-6 grid gap-4">
            <div className="rounded-xl border border-white/10 bg-[#111f38] p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h3 className="text-xs font-semibold text-gold uppercase tracking-wider">AI Memory</h3>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['short', 'Short'],
                    ['full', 'Full'],
                    ['decisions', 'Decisions'],
                    ['actions', 'Actions'],
                    ['moments', 'Moments'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setMemoryMode(key as MemoryMode)}
                      className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                        memoryMode === key ? 'border-gold text-gold bg-gold/10' : 'border-white/10 text-gray-400'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-sm text-gray-200 whitespace-pre-line leading-relaxed">{memoryOutput || 'Join the room to generate AI memory outputs.'}</p>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Join Late', value: 'Catch-up ready' },
                  { label: 'Decisions', value: `${transcriptInsights.decisions.length}` },
                  { label: 'Actions', value: `${transcriptInsights.actions.length}` },
                  { label: 'Moments', value: `${transcriptInsights.keyMoments.length}` },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-gray-500">{stat.label}</p>
                    <p className="text-xs text-gray-200">{stat.value}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#101d34] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Bot Listener</h3>
                <div className="flex items-center gap-2">
                  {(['invited', 'listening', 'live', 'processing', 'ready'] as BotState[]).map((state) => (
                    <button
                      key={state}
                      onClick={() => setBotState(state)}
                      className={`text-[10px] uppercase px-2 py-1 rounded-full border ${
                        botState === state ? 'border-gold text-gold' : 'border-white/10 text-gray-500'
                      }`}
                    >
                      {state}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-2 mb-3">
                <label className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                  Consent indicator
                  <input type="checkbox" checked={botConsent} onChange={(e) => setBotConsent(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
                  Admin join lock
                  <input type="checkbox" checked={botAdminLock} onChange={(e) => setBotAdminLock(e.target.checked)} />
                </label>
              </div>
              <p className="text-xs text-gray-400">
                Privacy: bot joins only when consent is visible and admin controls are enabled. State: <span className="text-gold">{botState}</span>.
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#101a2f] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Room Mode</h3>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['discussion', 'Discussion'],
                    ['meeting', 'Meeting'],
                    ['classroom', 'Classroom'],
                    ['concert', 'Concert'],
                    ['radio', 'Radio'],
                    ['listening_party', 'Listening Party'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setRoomMode(key as RoomMode)}
                      className={`text-[11px] px-2 py-1 rounded-full border ${
                        roomMode === key ? 'border-gold text-gold' : 'border-white/10 text-gray-500'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-sm text-gray-300">
                {roomMode === 'meeting' && 'Meeting mode emphasizes decisions, owners, and follow-up actions.'}
                {roomMode === 'concert' && 'Concert mode emphasizes external playback, moments, and audience reactions.'}
                {roomMode === 'classroom' && 'Classroom mode emphasizes chaptered replay and key lesson moments.'}
                {roomMode === 'radio' && 'Radio mode emphasizes seamless listening and archive continuity.'}
                {roomMode === 'listening_party' && 'Listening party mode emphasizes shared playback and highlights.'}
                {roomMode === 'discussion' && 'Discussion mode balances open talk, hot seat rotation, and transcript coverage.'}
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#0f1b32] p-4">
              <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider mb-3">External Audio Playback</h3>
              <div className="flex gap-2 mb-2">
                <input
                  type="url"
                  value={externalAudioUrl}
                  onChange={(e) => setExternalAudioUrl(e.target.value)}
                  placeholder="https://.../audio.mp3"
                  className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500"
                />
                <button
                  onClick={() => {
                    if (!externalAudioUrl.trim()) return;
                    setExternalQueue((prev) => [...prev, externalAudioUrl.trim()]);
                    setExternalAudioUrl('');
                    toast('Added to playback queue', 'success');
                  }}
                  className="px-3 py-2 rounded-lg bg-gold text-navy text-sm font-semibold"
                >
                  Queue
                </button>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => {
                    setExternalLoading(true);
                    setTimeout(() => {
                      setExternalLoading(false);
                      setExternalPlaying((v) => !v);
                    }, 450);
                  }}
                  className="px-3 py-2 rounded-lg border border-white/15 text-xs"
                >
                  {externalLoading ? 'Buffering...' : externalPlaying ? 'Pause media' : 'Play media'}
                </button>
                <span className="text-xs text-gray-500">Live room audio remains separate from hosted media playback.</span>
              </div>
              <audio controls className="w-full" src={externalQueue[0] || room.audio_source_url || undefined} />
              {externalQueue.length > 0 && (
                <div className="mt-2 space-y-1">
                  {externalQueue.slice(0, 3).map((url, idx) => (
                    <p key={`${url}-${idx}`} className="text-[11px] text-gray-400 truncate">{idx + 1}. {url}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-white/10 bg-[#101d34] p-4">
              <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider mb-3">Session Replay</h3>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <p className="text-xs text-gray-500 mb-1">Chaptered Replay</p>
                  <p className="text-sm text-gray-300">Jump by topic, not by random scrub points.</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <p className="text-xs text-gray-500 mb-1">Speaker Timeline</p>
                  <p className="text-sm text-gray-300">See who spoke most and when decisions happened.</p>
                </div>
              </div>
            </div>
          </div>

          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">🔥 Hot Seat</h2>
          {(() => {
            const occupiedSeats = room.current_speakers || [];
            const emptyCount = room.hot_seat_count - occupiedSeats.length;
            const maxEmptyShown = occupiedSeats.length > 0 ? 2 : 0;
            const emptyToShow = Math.min(emptyCount, maxEmptyShown);
            const remainingEmpty = emptyCount - emptyToShow;

            // No speakers at all - show compact placeholder
            if (occupiedSeats.length === 0) {
              return (
                <div className="text-center py-6 text-gray-400 bg-[#1a2a4a] rounded-xl border border-dashed border-white/20">
                  <p className="text-2xl mb-2">{'\u{1FA91}'}</p>
                  <p className="text-sm">{room.hot_seat_count} seats available</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {room.state === 'scheduled' ? 'Starts soon' : 'Sign in to take a seat'}
                  </p>
                </div>
              );
            }

            // Has speakers - show occupied + up to 2 empty placeholders
            return (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {occupiedSeats.map((speaker) => (
                    <div
                      key={`speaker-${speaker.fid}`}
                      className="rounded-xl p-4 border-2 transition-colors bg-[#1a2a4a] border-gold"
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center text-gold font-bold text-sm">
                          {speaker.username[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{speaker.username}</p>
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs text-gray-400">🔥 Hot seat</p>
                            <SpeakerTime joinedAt={speaker.joinedAt} />
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {isHost && speaker.fid !== user?.fid && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'kick_speaker', targetFid: speaker.fid }),
                                  });
                                  if (res.ok) {
                                    toast(`Moved @${speaker.username} to listeners`, 'info');
                                    await fetchRoom();
                                  }
                                }}
                                className="text-[10px] text-red-400 hover:text-red-300"
                                title="Move to listeners"
                              >
                                kick
                              </button>
                            )}
                            <TipButton
                              speakerFid={speaker.fid}
                              speakerUsername={speaker.username}
                              roomId={room.id}
                              authFetch={authFetch}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {Array.from({ length: emptyToShow }).map((_, i) => (
                    <div
                      key={`empty-${i}`}
                      className="rounded-xl p-4 border-2 transition-colors bg-[#1a2a4a] border-dashed border-white/20"
                    >
                      <div className="text-center text-gray-500 text-sm py-2">Empty seat</div>
                    </div>
                  ))}
                </div>
                {remainingEmpty > 0 && (
                  <p className="text-xs text-gray-500 mt-2 text-center">+{remainingEmpty} more {remainingEmpty === 1 ? 'seat' : 'seats'} available</p>
                )}
              </>
            );
          })()}

          {/* Gate error alert */}
          {gateError && (
            <div className="mt-4 p-3 bg-red-900/20 border border-red-600/30 rounded-lg">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm text-red-400 font-medium">{gateError.message}</p>
                  {gateError.details && (
                    <p className="text-xs text-red-400/70 mt-1">{gateError.details}</p>
                  )}
                </div>
                <button
                  onClick={() => setGateError(null)}
                  className="text-red-400/50 hover:text-red-400 text-xs shrink-0"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Join Controls — only shown for active rooms */}
          {room.state === 'active' && (
            <div className="mt-4 sm:mt-6 flex flex-wrap gap-2 sm:gap-3">
              {!user ? (
                <div className="flex flex-wrap items-center gap-3">
                  {!audioJoined ? (
                    <button
                      onClick={() => {
                        setJoinedRole('listener');
                        setAudioJoined(true);
                        setGuestMode(true);
                      }}
                      className="bg-white/10 text-white font-semibold px-6 py-3 rounded-xl hover:bg-white/20 transition-colors min-h-[44px] text-sm"
                    >
                      Listen In
                    </button>
                  ) : (
                    <span className="text-sm text-gray-400">Listening as {guestNameRef.current}</span>
                  )}
                  <p className="text-gray-500 text-xs">Sign in to speak or chat</p>
                </div>
              ) : isSpeaker ? (
                <>
                  {!audioJoined && (
                    <button
                      onClick={joinAsSpeaker}
                      disabled={joining}
                      className="bg-gold text-navy font-semibold px-4 py-2 rounded-lg hover:bg-[#d4941f] transition-colors disabled:opacity-50 min-h-[44px]"
                    >
                      {joining ? 'Joining...' : 'Join Audio'}
                    </button>
                  )}
                  <button
                    onClick={leave}
                    className="bg-red-600/20 border border-red-600 text-red-400 px-4 py-2 rounded-lg hover:bg-red-600/30 transition-colors min-h-[44px]"
                  >
                    Leave hot seat
                  </button>
                </>
              ) : isListener ? (
                <>
                  {!audioJoined && (
                    <button
                      onClick={joinAsListener}
                      disabled={joining}
                      className="border border-white/20 px-4 py-2 rounded-lg hover:bg-white/5 transition-colors disabled:opacity-50 min-h-[44px]"
                    >
                      {joining ? 'Joining...' : 'Join Audio (Listener)'}
                    </button>
                  )}
                  {/* Raise hand button */}
                  <button
                    onClick={async () => {
                      if (!user) return;
                      const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'raise_hand', fid: user.fid, username: user.username }),
                      });
                      if (res.ok) {
                        const data = await res.json();
                        toast(data.raised ? 'Hand raised!' : 'Hand lowered', 'info');
                        await fetchRoom();
                      }
                    }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors min-h-[44px] ${
                      room.hand_raises?.some((r) => r.fid === user?.fid)
                        ? 'bg-gold/20 text-gold border border-gold/30'
                        : 'border border-white/20 hover:bg-white/5'
                    }`}
                  >
                    {room.hand_raises?.some((r) => r.fid === user?.fid) ? '✋ Hand Raised' : '✋ Raise Hand'}
                  </button>
                  {room.hand_raises?.some((r) => r.fid === user?.fid) && (
                    <span className="text-xs text-gold">
                      You&apos;re #{(room.hand_raises?.findIndex((r) => r.fid === user?.fid) ?? 0) + 1} in queue
                    </span>
                  )}
                  {hotSeatFull ? (
                    <button
                      onClick={rotateIn}
                      disabled={!room.rotation_enabled || joining}
                      className="bg-gold text-navy font-semibold px-4 py-2 rounded-lg hover:bg-[#d4941f] transition-colors disabled:opacity-50 min-h-[44px]"
                    >
                      Rotate in
                    </button>
                  ) : (
                    <button
                      onClick={joinAsSpeaker}
                      disabled={hotSeatFull || joining}
                      className="bg-gold text-navy font-semibold px-4 py-2 rounded-lg hover:bg-[#d4941f] transition-colors disabled:opacity-50 min-h-[44px]"
                    >
                      {hotSeatFull ? 'Hot seat full' : 'Join hot seat'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    onClick={joinAsSpeaker}
                    disabled={hotSeatFull || joining}
                    className="bg-gold text-navy font-semibold px-4 py-2 rounded-lg hover:bg-[#d4941f] transition-colors disabled:opacity-50 min-h-[44px]"
                  >
                    {hotSeatFull ? 'Hot seat full' : 'Join hot seat'}
                  </button>
                  <button
                    onClick={joinAsListener}
                    className="border border-white/20 px-4 py-2 rounded-lg hover:bg-white/5 transition-colors min-h-[44px]"
                  >
                    Join as listener
                  </button>
                </>
              )}
            </div>
          )}

          {/* Hand raise queue — host only */}
          {isHost && room.hand_raises && room.hand_raises.length > 0 && (
            <div className="mt-4 p-3 bg-[#1a2a4a] rounded-xl border border-gold/20">
              <h4 className="text-xs font-semibold text-gold uppercase tracking-wider mb-2">
                ✋ Hand Raises ({room.hand_raises.length})
              </h4>
              <div className="space-y-2">
                {room.hand_raises.map((r, index) => (
                  <div key={r.fid} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gold bg-gold/10 w-6 h-6 rounded-full flex items-center justify-center">
                        {index + 1}
                      </span>
                      <span className="text-sm text-white truncate max-w-[120px]">@{r.username}</span>
                      <span className="text-[10px] text-gray-500">{timeAgo(r.joinedAt)}</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          const res = await authFetch(`/api/fishbowlz/rooms/${roomId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'approve_hand', targetFid: r.fid }),
                          });
                          if (res.ok) {
                            toast(`@${r.username} approved to hot seat`, 'success');
                            await fetchRoom();
                          } else {
                            const err = await res.json().catch(() => ({}));
                            toast(err.error || 'Failed to approve', 'error');
                          }
                        }}
                        className="text-xs px-2 py-1 bg-gold/15 text-gold-light rounded hover:bg-gold/25 transition-colors"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Room description */}
          {room.description && (
            <div className="mt-6 p-4 bg-[#1a2a4a] rounded-xl border border-white/10">
              <p className="text-gray-300 text-sm">{room.description}</p>
            </div>
          )}
        </div>

        {/* Sidebar — Listeners + Transcript + Chat + Reactions */}
        <div className="lg:w-80 border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col lg:h-[calc(100vh-57px)] lg:sticky lg:top-[57px]">
          {/* Listeners */}
          <div className="p-4 border-b border-white/10">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              👥 Listening ({room.current_listeners?.length || 0})
            </h3>
            <div className="flex flex-wrap gap-2">
              {(room.current_listeners || []).map((l, i) => (
                <span key={i} className="text-xs bg-white/10 px-2 py-1 rounded-full">
                  @{l.username}
                </span>
              ))}
              {(room.current_listeners || []).length === 0 && (
                <span className="text-xs text-gray-500">No listeners yet</span>
              )}
            </div>
          </div>

          {/* Transcript + Archive */}
          <div className="flex-1 flex flex-col overflow-hidden max-h-[42vh] lg:max-h-none">
            <div className="p-4 border-b border-white/10 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {room.state === 'ended' ? 'Transcript Archive' : 'Live Transcript'}
                </h3>
                <div className="flex items-center gap-2">
                  {transcripts.length > 0 && !recap && (
                    <button
                      onClick={fetchRecap}
                      disabled={recapLoading}
                      className="text-xs px-2 py-1 rounded-full bg-gold/10 text-gold hover:bg-gold/20 transition-colors disabled:opacity-50"
                    >
                      {recapLoading ? 'Generating' : 'Catch up'}
                    </button>
                  )}
                  <a
                    href={`/api/fishbowlz/export?roomId=${room.id}`}
                    download
                    className="text-xs px-2 py-1 rounded-full border border-white/15 text-gray-300 hover:bg-white/5"
                  >
                    TXT
                  </a>
                  <button onClick={openPdfReadyView} className="text-xs px-2 py-1 rounded-full border border-white/15 text-gray-300 hover:bg-white/5">PDF</button>
                  <button onClick={downloadJsonExport} className="text-xs px-2 py-1 rounded-full border border-white/15 text-gray-300 hover:bg-white/5">JSON</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  ['full', 'Full'],
                  ['summary', 'Summary'],
                  ['highlights', 'Highlights'],
                  ['decisions', 'Decisions'],
                  ['actions', 'Actions'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTranscriptMode(key as TranscriptMode)}
                    className={`text-[10px] uppercase px-2 py-1 rounded-full border ${
                      transcriptMode === key ? 'border-gold text-gold' : 'border-white/10 text-gray-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={transcriptQuery}
                  onChange={(e) => setTranscriptQuery(e.target.value)}
                  placeholder="Search transcript..."
                  className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-500"
                />
                <button onClick={copyCurrentTranscript} className="text-xs px-3 py-2 rounded-lg border border-white/15 text-gray-300 hover:bg-white/5">
                  Copy
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {recap && transcriptMode === 'summary' && (
                <div className="p-3 rounded-lg bg-gold/5 border border-gold/20">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gold">AI Recap</span>
                    <button
                      onClick={() => setRecap(null)}
                      className="text-xs text-gray-500 hover:text-gray-300"
                      aria-label="Dismiss recap"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-sm text-gray-200 whitespace-pre-line leading-relaxed">{recap}</p>
                </div>
              )}
              {filteredTranscriptItems.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-8">
                  No transcript items found for this mode.
                </p>
              ) : (
                <>
                  {filteredTranscriptItems.slice(0, showAllTranscripts ? undefined : 20).map((item) => (
                    <div key={`${item.id}-${item.started_at}`} className="py-2 border-b border-white/5 last:border-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-gold">{item.speaker_name}</span>
                        <span className="text-xs text-gray-500">[{item.speaker_role}]</span>
                        <span className="text-xs text-gray-600">{timestampLabel(item.started_at)}</span>
                      </div>
                      <p className="text-sm text-gray-200 leading-relaxed">{item.text}</p>
                    </div>
                  ))}
                  {!showAllTranscripts && filteredTranscriptItems.length > 20 && (
                    <button
                      onClick={() => setShowAllTranscripts(true)}
                      className="w-full py-2 text-xs text-gold hover:text-[#d4941f] transition-colors"
                    >
                      Show all ({filteredTranscriptItems.length - 20} more)
                    </button>
                  )}
                  <div ref={transcriptBottomRef} />
                </>
              )}
            </div>
          </div>

          <div className="border-t border-white/10 p-4 space-y-3 max-h-[32vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Memory Archive</h4>
              <span className="text-[11px] text-gray-500">Post-session view</span>
            </div>
            <div className="flex gap-2">
              <input
                value={archiveQuery}
                onChange={(e) => setArchiveQuery(e.target.value)}
                placeholder="Search summaries and decisions"
                className="flex-1 bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-500"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                ['all', 'All'],
                ['summary', 'Summary'],
                ['decisions', 'Decisions'],
                ['actions', 'Actions'],
                ['moments', 'Moments'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setArchiveFilter(key as 'all' | 'summary' | 'decisions' | 'actions' | 'moments')}
                  className={`text-[10px] uppercase px-2 py-1 rounded-full border ${
                    archiveFilter === key ? 'border-gold text-gold' : 'border-white/10 text-gray-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {archiveEntries.slice(0, 8).map((entry) => (
              <div key={entry.id} className="rounded-lg border border-white/10 bg-black/20 p-2">
                <p className="text-[10px] uppercase tracking-wider text-gray-500">{entry.type}</p>
                <p className="text-xs text-gray-100 mt-1">{entry.title}</p>
                <p className="text-xs text-gray-400 mt-1 line-clamp-2">{entry.text}</p>
              </div>
            ))}
            {archiveEntries.length === 0 && (
              <p className="text-xs text-gray-500">No archive matches this filter yet.</p>
            )}
          </div>

          {/* Room Chat */}
          <div className="flex-1 flex flex-col border-t border-white/10 min-h-[150px] max-h-[30vh] lg:max-h-none">
            <FishbowlChat roomId={room.id} authFetch={authFetch} />
          </div>

          {/* Reactions */}
          {room.state === 'active' && (
            <div className="p-3 border-t border-white/10">
              <Reactions roomId={room.id} authFetch={authFetch} />
            </div>
          )}
        </div>
      </div>

      {/* Spacer for sticky mobile bottom bar */}
      {audioJoined && room?.state === 'active' && (
        <div className="lg:hidden h-20" />
      )}

      {/* Sticky mobile audio controls */}
      {audioJoined && (user || guestMode) && room?.state === 'active' && (
        <div
          className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-navy-light border-t border-white/10 px-4 py-3 flex items-center justify-between"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-white text-sm font-medium truncate">{room.title}</span>
            <span className="text-gray-500 text-xs shrink-0">
              {(room.current_speakers?.length || 0) + (room.current_listeners?.length || 0)} in room
            </span>
          </div>
          <button
            onClick={() => {
              setAudioJoined(false);
              setGuestMode(false);
              if (user) {
                const action = isSpeaker ? 'leave_speaker' : 'leave_listener';
                authFetch(`/api/fishbowlz/rooms/${roomId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action, fid: user.fid }),
                }).catch(() => {});
              }
            }}
            className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-xs font-semibold min-h-[44px] shrink-0"
          >
            Leave
          </button>
        </div>
      )}

      {room && (
        <ShareModal
          url={typeof window !== 'undefined' ? `${window.location.origin}/fishbowlz/${room.slug || roomId}` : ''}
          title={`Join "${room.title}" on FISHBOWLZ`}
          description={room.description || `A live fishbowl hosted by @${room.host_username}`}
          isOpen={showShare}
          onClose={() => setShowShare(false)}
        />
      )}

      {showEndedOverlay && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true">
          <div className="bg-[#1a2a4a] rounded-xl p-6 w-full max-w-sm border border-white/10 text-center">
            <div className="text-4xl mb-3">🐟</div>
            <h2 className="text-lg font-bold mb-1">This fishbowl has ended</h2>
            <p className="text-sm text-gray-400 mb-1">
              {endedRoomRef.current?.title || room?.title}
            </p>
            <p className="text-xs text-gray-500 mb-4">
              Hosted by @{endedRoomRef.current?.host_username || room?.host_username}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => router.push('/fishbowlz')}
                className="w-full bg-gold text-navy font-semibold py-2.5 rounded-lg hover:bg-[#d4941f] transition-colors"
              >
                Back to Rooms
              </button>
              {transcripts.length > 0 && (
                <button
                  onClick={() => {
                    setShowEndedOverlay(false);
                    setEndedCountdown(0);
                  }}
                  className="w-full border border-white/20 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-sm"
                >
                  View Transcript
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-3">Redirecting in {endedCountdown}...</p>
          </div>
        </div>
      )}

      {showEndConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a2a4a] rounded-xl p-6 w-full max-w-sm border border-white/10">
            <h2 className="text-lg font-bold mb-2">End this fishbowl?</h2>
            <p className="text-sm text-gray-400 mb-4">This will disconnect all participants and close the room. Transcripts are preserved.</p>
            <div className="flex gap-3">
              <button
                onClick={endRoom}
                className="flex-1 bg-red-600 text-white font-semibold py-2.5 rounded-lg hover:bg-red-700 transition-colors"
              >
                End Room
              </button>
              <button
                onClick={() => setShowEndConfirm(false)}
                className="flex-1 border border-white/20 py-2.5 rounded-lg hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page export — wraps inner component with ToastProvider ──────────────────

export default function FishbowlRoomPage() {
  return (
    <ToastProvider>
      <FishbowlRoomPageInner />
    </ToastProvider>
  );
}
