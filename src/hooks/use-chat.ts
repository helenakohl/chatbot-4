import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { appConfig } from "../../config.browser";
import { v4 as uuidv4 } from 'uuid';

const API_PATH = "/api/chat";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function streamAsyncIterator(stream: ReadableStream) {
  const reader = stream.getReader();
  return {
    next() {
      return reader.read();
    },
    return() {
      reader.releaseLock();
      return {
        value: {},
      };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export function useChat() {
  const [userId, setUserId] = useState<string | null>(null);
  const [currentChat, setCurrentChat] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<"idle" | "waiting" | "loading">("idle");

  // Lets us cancel the stream
  const abortController = useMemo(() => new AbortController(), []);

  function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number,
    immediate = false
  ): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
  
    return function(this: any, ...args: Parameters<T>) {
      const context = this;
  
      const later = function() {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };
  
      const callNow = immediate && !timeout;
  
      if (timeout) clearTimeout(timeout);
  
      timeout = setTimeout(later, wait);
  
      if (callNow) func.apply(context, args);
    };
  }

  useEffect(() => {
    const storedUserId = localStorage.getItem('chatUserId');
    if (storedUserId) {
      setUserId(storedUserId);
    } else {
      const newUserId = uuidv4();
      localStorage.setItem('chatUserId', newUserId);
      setUserId(newUserId);
    }
  }, []);

  const writeToGoogleSheet = async (message: string, from: 'user' | 'assistant') => {
    if (!userId) return;
    
    try {
      const response = await fetch('/.netlify/functions/logMessages', {
        method: 'POST',
        body: JSON.stringify({ message, from, userId }),
      });
      if (!response.ok) {
        console.error('Failed to write to Google Sheet');
      }
    } catch (error) {
      console.error('Error writing to Google Sheet:', error);
    }
  };

  // Cancels the current chat and adds the current chat to the history
  function cancel() {
    setState("idle");
    abortController.abort();
    if (currentChat) {
      const newHistory = [
        ...chatHistory,
        { role: "user", content: currentChat } as const,
      ];

      setChatHistory(newHistory);
      setCurrentChat("");
    }
  }

  // Clears the chat history
  function clear() {
    console.log("clear");
    setChatHistory([]);
  }

  // Delay function
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Sends a new message to the AI function and streams the response
  const sendMessageImpl = useCallback(async (
    message: string,
    chatHistory: Array<ChatMessage>,
  ) => {
    if (state !== "idle") {
      console.log("Cannot send message while processing");
      return;
    }

    setState("waiting");
    const newHistory = [
      ...chatHistory,
      { role: "user", content: message } as const,
    ];

    await writeToGoogleSheet(message, 'user');

    setChatHistory(newHistory);

    const body = JSON.stringify({
      messages: newHistory.slice(-appConfig.historyLength),
    });

    const decoder = new TextDecoder();

    const res = await fetch(API_PATH, {
      body,
      method: "POST",
      signal: abortController.signal,
    });

    setCurrentChat("Typing ...");

    await delay(5000);

    if (!res.ok || !res.body) {
      setState("idle");
      return;
    }

    let fullResponse = "";

    for await (const event of streamAsyncIterator(res.body)) {
      setState("loading");
      const data = decoder.decode(event).split("\n");
      for (const chunk of data) {
        if (!chunk) continue;
        const message = JSON.parse(chunk);
        const content = message?.choices?.[0]?.delta?.content;
        if (content) {
          fullResponse += content;
        }
      }
    }

    setChatHistory((curr) => [
      ...curr,
      { role: "assistant", content: fullResponse } as const,
    ]);

    writeToGoogleSheet(fullResponse, 'assistant');

    setCurrentChat(null);
    setState("idle");
  }, [state, abortController, writeToGoogleSheet]);

  const sendMessage = useMemo(() => debounce(sendMessageImpl, 300, true), [sendMessageImpl]);

  return { sendMessage, currentChat, chatHistory, cancel, clear, state };
}
