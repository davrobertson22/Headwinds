// Supabase browser client — auth only (the game API is @headwinds/server).
// If env isn't configured yet, export null and the app renders a setup notice.
import { createClient } from '@supabase/supabase-js';

// `?.` so the module also loads under plain Node (SSR smoke tests) where
// import.meta.env doesn't exist. Vite injects it in the browser either way.
const url = import.meta.env?.VITE_SUPABASE_URL;
const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
