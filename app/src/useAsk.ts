import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConversation, fetchConversations, postAsk, resolveAskAction } from "./api";
import { loadConversationId, pendingMessage, saveConversationId, settle } from "./ask";
import { events } from "./events";
import type { ChatMessage, Conversation } from "./types";

// Ask's chat state (docs/SDD-wissel-app.md §3.4). The shell holds it,
// not the Ask screen, so a reply that arrives while Milton is on another
// tab is there when he comes back. The open chat's id is kept in
// localStorage so a reload reopens it.

export interface AskState {
  conversationId: string | null;
  messages: ChatMessage[];
  /** False until the saved chat (if any) has been read. */
  loaded: boolean;
  /** A reply is on its way: this tab sent the message, or another tab
   *  or phone did and `/events` said so. */
  thinking: boolean;
  error: string | null;
  /** Earlier chats, once listChats has run. */
  chats: Conversation[] | null;
  send: (text: string) => void;
  newChat: () => void;
  openChat: (id: string) => void;
  listChats: () => void;
  /** A Confirm, Undo or Cancel tap (§3.7). Resolves once the board and
   *  the message show the result; rejects with the server's reason. */
  resolvePending: (pendingId: string, verb: "confirm" | "cancel") => Promise<void>;
}

/** `refreshBoard` refetches /tasks. A reply is shown only after it, so
 *  a card the reply just made already has its chip: the board event for
 *  it can be missed (the EventSource still connecting) or land after the
 *  reply. */
export function useAsk(refreshBoard: () => Promise<void>): AskState {
  const refresh = useRef(refreshBoard);
  refresh.current = refreshBoard;
  const boardFirst = useCallback(() => refresh.current().catch(() => {}), []);
  const [conversationId, setConversationId] = useState<string | null>(() => loadConversationId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [remoteThinking, setRemoteThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<Conversation[] | null>(null);
  // The open chat as of now, for callbacks that outlive a render.
  const current = useRef(conversationId);
  current.current = conversationId;
  // Bumped on every chat switch: a reply to a message sent before the
  // switch is left on the server, never mixed into the new chat.
  const generation = useRef(0);
  const sendingRef = useRef(false);

  const load = useCallback(async (id: string) => {
    try {
      const detail = await fetchConversation(id);
      if (current.current !== id) return;
      if (!detail) {
        // Gone (a fresh database): start over quietly.
        setConversationId(null);
        saveConversationId(null);
        setMessages([]);
      } else {
        setMessages((prev) => [...detail.messages, ...prev.filter((m) => m.id.startsWith("pending-"))]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (conversationId) void load(conversationId);
    else setLoaded(true);
    // Only the first open: later switches load in switchTo.
  }, []);

  useEffect(
    () =>
      events.subscribeAsk((e) => {
        // While this tab waits on its own POST, that answer settles the
        // chat (and a reload after it picks up anything else), so a
        // refetch now would only show the message twice for a moment.
        if (e.conversationId !== current.current || sendingRef.current) return;
        if (e.type === "ask.thinking") setRemoteThinking(true);
        // ask.action and ask.pending come just before their ask.replied,
        // which reloads; ask.confirmed is a tap, here or elsewhere.
        else if (e.type === "ask.replied" || e.type === "ask.confirmed") {
          if (e.type === "ask.replied") setRemoteThinking(false);
          void boardFirst().then(() => load(e.conversationId));
        }
      }),
    [load, boardFirst],
  );

  const send = useCallback(
    (text: string) => {
      if (sendingRef.current) return;
      const id = current.current;
      const gen = generation.current;
      const pending = pendingMessage(text, id ?? "", new Date().toISOString());
      setMessages((prev) => [...prev, pending]);
      sendingRef.current = true;
      setSending(true);
      setError(null);
      postAsk(text, id ?? undefined).then(
        async (result) => {
          await boardFirst();
          if (generation.current !== gen) return;
          if (!id) {
            setConversationId(result.conversation.id);
            current.current = result.conversation.id;
            saveConversationId(result.conversation.id);
          }
          setMessages((prev) => settle(prev, pending.id, result));
          sendingRef.current = false;
          setSending(false);
          setRemoteThinking(false);
          void load(result.conversation.id);
        },
        (err: unknown) => {
          if (generation.current !== gen) return;
          setMessages((prev) => prev.filter((m) => m.id !== pending.id));
          setError(err instanceof Error ? err.message : String(err));
          sendingRef.current = false;
          setSending(false);
        },
      );
    },
    [load, boardFirst],
  );

  const switchTo = useCallback(
    (id: string | null) => {
      generation.current++;
      setConversationId(id);
      current.current = id;
      saveConversationId(id);
      setMessages([]);
      setRemoteThinking(false);
      sendingRef.current = false;
      setSending(false);
      setError(null);
      if (id) {
        setLoaded(false);
        void load(id);
      }
    },
    [load],
  );

  const newChat = useCallback(() => switchTo(null), [switchTo]);
  const openChat = useCallback((id: string) => switchTo(id), [switchTo]);
  const listChats = useCallback(() => {
    fetchConversations().then(setChats, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const resolvePending = useCallback(
    async (pendingId: string, verb: "confirm" | "cancel") => {
      const id = current.current;
      if (!id) throw new Error("no chat is open");
      const result = await resolveAskAction(pendingId, id, verb);
      await boardFirst();
      if (current.current !== id) return;
      setMessages((prev) => prev.map((m) => (m.id === result.message.id ? result.message : m)));
    },
    [boardFirst],
  );

  return { conversationId, messages, loaded, thinking: sending || remoteThinking, error, chats, send, newChat, openChat, listChats, resolvePending };
}
