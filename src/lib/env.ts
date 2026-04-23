export const env = {
  appName: import.meta.env.VITE_APP_NAME || 'Sutra',
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  t212BridgeUrl: import.meta.env.VITE_T212_BRIDGE_URL || '',
};

export function hasSupabaseConfig() {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}
