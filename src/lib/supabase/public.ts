import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * How long one request may take. The anon role's statement timeout is a few seconds, so a request
 * still waiting after this means Supabase isn't answering (Cloudflare holds it for over a minute
 * before a 522). Failing sooner lets pages fall back, and keeps a build from hitting Next's 60s
 * limit per page and failing the deploy (Oct 29).
 */
const REQUEST_TIMEOUT_MS = 10_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

/**
 * A server-side client for public tables that every visitor sees the same way. No cookies, so pages
 * that use it stay cached.
 */
export function publicClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY;
    if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY");
    return createClient(url, key, { auth: { persistSession: false }, global: { fetch: fetchWithTimeout } });
}
