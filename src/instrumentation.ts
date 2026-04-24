import { preloadEnv } from '@/lib/db/supabase';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await preloadEnv();
  }
}
