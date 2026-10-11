import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark, ErrorAlert, Spinner } from '../components/ui';
import { api, ApiError, newClientId, storage } from '../lib/api';
import type { ChatMessage } from '../lib/types';
import { MessageCards } from './MessageCards';

const SESSION_KEY = 'cp.chat.session';
interface Session {
  id: string;
  token: string;
}
interface HistoryResponse {
  messages: ChatMessage[];
  requirements: { summary: string[] };
}
interface SendResponse {
  inbound: ChatMessage;
  reply: ChatMessage;
  requirements: { summary: string[] };
}

const EXAMPLES = [
  'I need a 2BHK for rent in Velachery under ₹25,000, with parking',
  'Show me 3BHK flats to buy in Adyar',
  'Pet-friendly house for rent in Anna Nagar',
  'Rentals on OMR under 22k',
];

export function ChatPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [summary, setSummary] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; clientId: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);

  const startSession = useCallback(async () => {
    const res = await api<{ session_id: string; token: string }>('/api/chat/sessions', { body: {} });
    const s = { id: res.session_id, token: res.token };
    storage.set(SESSION_KEY, s);
    setSession(s);
    setMessages([]);
    setSummary([]);
    return s;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const saved = storage.get<Session>(SESSION_KEY);
      if (saved?.id && saved.token) {
        try {
          const hist = await api<HistoryResponse>(`/api/chat/sessions/${saved.id}/messages`, { token: saved.token });
          setSession(saved);
          setMessages(hist.messages);
          setSummary(hist.requirements.summary);
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || ![401, 404].includes(err.status)) throw err;
          storage.remove(SESSION_KEY); // stale session (e.g. demo data reset) — start fresh
        }
      }
      await startSession();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the chat.');
    } finally {
      setLoading(false);
    }
  }, [startSession]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, pending]);

  const send = useCallback(
    async (text: string, clientId = newClientId()) => {
      const trimmed = text.trim();
      if (!trimmed || !session || sendingRef.current) return; // prevent double submission
      sendingRef.current = true;
      setSending(true);
      setError(null);
      setPending({ text: trimmed, clientId });
      setDraft('');
      try {
        const res = await api<SendResponse>(`/api/chat/sessions/${session.id}/messages`, {
          body: { text: trimmed, client_message_id: clientId },
          token: session.token,
        });
        setMessages((m) => [...m.filter((x) => x.id !== res.inbound.id && x.id !== res.reply.id), res.inbound, res.reply]);
        setSummary(res.requirements.summary);
        setPending(null);
      } catch (err) {
        // Keep the text so nothing the customer typed is lost; the same client id makes a retry idempotent.
        setDraft(trimmed);
        setError(err instanceof ApiError ? err.message : 'Message failed to send.');
      } finally {
        sendingRef.current = false;
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [session],
  );

  const retryPending = () => pending && void send(pending.text, pending.clientId);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }
  async function newConversation() {
    if (sending) return;
    setError(null);
    setPending(null);
    try {
      await startSession();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a new conversation.');
    }
  }

  const lastOutboundId = [...messages].reverse().find((m) => m.direction === 'outbound')?.id;

  return (
    <div className="chat-shell">
      <div className="demo-banner" role="note">
        Prototype · all listings shown are <strong>sample demonstration data</strong>, not live ChennaiProperties inventory.
      </div>
      <header className="chat-header">
        <Link to="/" className="brand" aria-label="ChennaiProperties home">
          <BrandMark />
          <span>
            <span className="brand-name">ChennaiProperties</span>
            <br />
            <span className="brand-sub">AI property assistant</span>
          </span>
        </Link>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={newConversation} disabled={sending || loading}>
          New chat
        </button>
      </header>

      {summary.length > 0 && (
        <div className="req-bar" aria-label="Current search">
          <span className="label">Searching:</span>
          {summary.map((s) => (
            <span key={s} className="badge badge-primary">
              {s}
            </span>
          ))}
        </div>
      )}

      <main className="chat-log" ref={logRef} aria-live="polite" aria-busy={sending}>
        {loading ? (
          <div className="welcome">
            <Spinner label="Loading conversation" />
          </div>
        ) : messages.length === 0 && !pending ? (
          <div className="welcome">
            <h1>Find your next home in Chennai</h1>
            <p className="muted">Tell me what you need — rent or buy, area, budget, BHK, parking, pets. I only show listings stored in our database.</p>
            <div className="chips">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip" onClick={() => void send(ex)} disabled={!session || sending}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`msg ${m.direction === 'inbound' ? 'msg-in' : 'msg-out'}`}>
              <div className="bubble">{m.body}</div>
              {m.direction === 'outbound' && session && (
                <MessageCards cards={m.cards} session={session} isLatest={m.id === lastOutboundId} onAsk={(t) => void send(t)} disabled={sending} />
              )}
              {m.retryable && m.id === lastOutboundId && (
                <button
                  className="btn btn-sm"
                  disabled={sending}
                  onClick={() => {
                    const lastIn = [...messages].reverse().find((x) => x.direction === 'inbound');
                    if (lastIn) void send(lastIn.body);
                  }}
                >
                  Try again
                </button>
              )}
            </div>
          ))
        )}
        {pending && (
          <>
            <div className="msg msg-in">
              <div className="bubble">{pending.text}</div>
              {!sending && <span className="msg-meta">Not sent</span>}
            </div>
            {sending && (
              <div className="msg msg-out">
                <div className="bubble" aria-label="Assistant is typing">
                  <span className="typing">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="sr-only">Searching listings…</span>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      <div style={{ padding: error ? '0 16px 8px' : 0 }}>
        <ErrorAlert error={error} onRetry={pending ? retryPending : session ? undefined : () => void load()} />
      </div>

      <form className="composer" onSubmit={onSubmit}>
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          ref={inputRef}
          className="input"
          rows={1}
          placeholder="e.g. 2BHK for rent in Velachery under ₹25,000"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!session}
        />
        <button className="btn btn-primary" type="submit" disabled={!draft.trim() || sending || !session}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      <div className="subtle" style={{ textAlign: 'center', padding: '0 16px 10px', background: 'var(--surface)' }}>
        The assistant can make mistakes; availability and visits are confirmed by our team. <Link to="/admin">Staff login</Link>
      </div>
    </div>
  );
}
