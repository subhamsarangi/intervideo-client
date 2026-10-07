/**
 * Call Router: Handles dynamic call URL routing and session redirects
 * 
 * URL scheme:
 * - /call.html - Start a new call (redirects to /call/<sessionId>)
 * - /call/<sessionId> - Active call with session tracking
 * 
 * When user returns to a URL with a sessionId that has ended,
 * redirect to the session detail page.
 */

export interface CallRouteParams {
  sessionId?: string;
  isNewCall: boolean;
  isReturningToSession: boolean;
}

/**
 * Parse the current URL and return routing parameters
 */
export function parseCallRoute(): CallRouteParams {
  const url = new URL(window.location.href);
  const pathname = url.pathname;

  // Pattern: /call/<sessionId> or /call.html
  // SessionId format: 2026-10-02T18-40-08-542Z_1dcd3b (ISO with dashes/dots + UUID)
  const callMatch = pathname.match(/^\/call(?:\/([a-zA-Z0-9T:\-._Z]+))?(?:\.html)?$/);

  if (!callMatch) {
    return { isNewCall: true, isReturningToSession: false };
  }

  const sessionId = callMatch[1];

  return {
    sessionId,
    isNewCall: !sessionId,
    isReturningToSession: !!sessionId,
  };
}

/**
 * Update the browser URL with a new session ID
 * This is called when startCall() receives the sessionId from the server
 */
export function updateCallUrl(sessionId: string): void {
  const newUrl = `/call/${sessionId}`;
  window.history.replaceState({ sessionId }, `Call ${sessionId}`, newUrl);
}

/**
 * Check if a session exists (was saved)
 * Called when user returns to a /call/<sessionId> URL
 * If the session was ended and saved, redirect to session-detail
 */
export async function checkSessionExists(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Redirect to session detail page if the call has ended
 */
export function redirectToSessionDetail(sessionId: string): void {
  const detailUrl = `/session-detail.html?id=${encodeURIComponent(sessionId)}`;
  window.location.replace(detailUrl);
}

/**
 * Handle beforeunload: warn user before leaving an active call
 * Returns a string for the confirmation dialog (modern browsers show their own message)
 */
export function beforeunloadHandler(inCall: boolean): string | void {
  if (inCall) {
    const message =
      "This call will end forever if you leave. The transcript and recording will be saved.";
    // Modern browsers ignore the string and show their own message
    // but we return it for compatibility
    return message;
  }
}
