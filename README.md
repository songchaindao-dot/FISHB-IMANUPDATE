# FISHBOWLZ 🐟

**Persistent audio rooms with hot seat rotation.** Conversations that live forever.

[fishbowlz.com](https://fishbowlz.com) · Built on [Farcaster](https://farcaster.xyz) · By [The ZAO](https://zaoos.com)

---
.
## What is FISHBOWLZ?

Audio rooms where speakers rotate through a **hot seat** — like a fishbowl discussion. Everything is transcribed, archived, and searchable. Rooms persist after they end.

**No other product combines:** persistent rooms + async transcripts + hot seat rotation + Farcaster-native identity.

## Features

### Core
- 🔥 **Hot Seat Rotation** — configurable seats, auto-rotation timer (5/10/15 min)
- 🎙️ **Live Audio** — 100ms-powered, speaker/listener/moderator roles
- 📝 **Live Transcripts** — browser speech API + manual input, timestamped
- 💬 **Room Chat** — real-time text alongside audio
- ⏰ **Scheduled Rooms** — set a future time, countdown, Start Now button

### Social
- ✋ **Hand Raise** — listeners request the hot seat, host approves
- 🔥 **Emoji Reactions** — floating IG Live-style reactions
- 💰 **Speaker Tipping** — tip ETH during live rooms
- 🔗 **Share Links** — slug-based URLs (`fishbowlz.com/fishbowlz/my-room`)
- 📣 **Farcaster Auto-Cast** — posts to /fishbowlz channel on room create/end

### Host Controls
- 👢 **Kick Speaker** — move to listeners
- 🔒 **Token-Gated Rooms** — require ERC-20 balance on Base
- 🔐 **FC Identity Gating** — Farcaster quality score check
- 🛑 **End Room** — confirmation modal, auto-redirect participants

### Polish
- 🤖 **AI Summary** — Claude/Minimax generates transcript summary on room end
- 📥 **Export** — download transcript as Markdown
- 🖼️ **OG Images** — dynamic social cards for room links
- 🌙 **Dark Theme** — navy/gold, Spotify-inspired
- 📱 **Mobile-First** — responsive, 44px tap targets, bottom sheet modals
- ⏳ **Loading Skeletons** — smooth loading states
- 🐟 **Onboarding** — 3-step intro for first-time visitors
- 🔔 **Toast Notifications** — success/error/info with auto-dismiss

### Auth
- Privy integration — Farcaster + wallet + email + Google + Discord
- Embedded wallets for every user
- Server-side token verification

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Audio | 100ms React SDK |
| Auth | Privy (`@privy-io/react-auth`) |
| Database | Supabase (PostgreSQL + RLS) |
| Social | Neynar (Farcaster API) |
| AI | Minimax / Anthropic (transcript summaries) |
| Styling | Tailwind CSS v4 |
| Deploy | Vercel |
| Chain | Base (token gating, tipping) |

## Getting Started

```bash
git clone https://github.com/bettercallzaal/fishbowlz.git
cd fishbowlz
cp .env.example .env.local  # fill in your keys
npm install --legacy-peer-deps
npm run dev
```

### Required Services

1. **Supabase** — create project, run migrations in `supabase/migrations/`
2. **100ms** — create template with `speaker`, `moderator`, `listener` roles
3. **Privy** — create app at console.privy.io, enable Farcaster + wallet + email
4. **Neynar** — API key for Farcaster casting (optional)

### Environment Variables

See `.env.example` for the full list. Key ones:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_100MS_ACCESS_KEY=
HMS_APP_SECRET=
NEXT_PUBLIC_100MS_TEMPLATE_ID=
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=
SESSION_SECRET=
```

## Database

Run all migrations in `supabase/migrations/` in order:

```
20260404_fishbowlz.sql          — core tables (rooms, sessions, transcripts, events)
20260405_fishbowl_chat.sql      — chat messages
20260405_fc_identity_gating.sql — FC gating columns
20260405_fishbowl_scheduled.sql — scheduling columns
20260405_fishbowl_hand_raise.sql — hand raise column
20260405_fishbowl_rotation_timer.sql — rotation timer column
20260405_fishbowl_summary.sql   — AI summary columns
20260405_fishbowl_token_gate.sql — token gate columns
20260405_fishbowl_users.sql     — user profiles
```

## Architecture

```
src/
├── app/
│   ├── page.tsx                    # Landing page
│   ├── fishbowlz/
│   │   ├── page.tsx                # Room list + create
│   │   └── [id]/
│   │       ├── page.tsx            # Room detail (audio, chat, transcript)
│   │       └── opengraph-image.tsx # Dynamic OG images
│   └── api/fishbowlz/
│       ├── rooms/                  # CRUD + join/leave/rotate/kick/heartbeat
│       ├── chat/                   # Room chat messages
│       ├── transcripts/            # Transcript segments
│       ├── transcribe/             # Whisper proxy + manual input
│       ├── events/                 # Append-only event log
│       ├── sessions/               # Session tracking
│       ├── export/                 # Markdown export
│       ├── gate-check/             # Token balance verification
│       ├── users/                  # User profiles
│       └── webhook/privy/          # Auto user creation
├── components/
│   ├── fishbowlz/                  # Reactions, TipButton, Onboarding, Skeletons
│   ├── spaces/                     # HMSFishbowlRoom, Chat, TranscriptInput
│   └── ui/                         # Toast notifications
├── hooks/                          # useAuth (Privy-based)
└── lib/fishbowlz/                  # logger, castRoom, summarize, tokenGate
```

## Related

- **ZAO OS** — full community platform at [zaoos.com](https://zaoos.com) ([GitHub](https://github.com/bettercallzaal/ZAOOS))
- **The ZAO** — decentralized music community on Farcaster

## License

MIT
