"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/models/supabase";
import type { PostgrestError } from "@supabase/supabase-js";

// ─── Types ───
interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  status: "idle" | "loading" | "success" | "error";
}

interface QueryOptions {
  enabled?: boolean;
  retry?: number;
  retryDelay?: number;
  timeout?: number;
  onSuccess?: (data: any) => void;
  onError?: (error: string) => void;
}

// ─── useSupabaseQuery Hook ───
// Custom data-fetching hook with AbortController timeout (8000ms default),
// 2 retries with exponential backoff, and automatic cleanup.
export function useSupabaseQuery<T = any>(
  queryFn: (signal?: AbortSignal) => Promise<{ data: T | null; error: PostgrestError | null }>,
  deps: any[] = [],
  options: QueryOptions = {}
) {
  const {
    enabled = true,
    retry = 2,
    retryDelay = 1000,
    timeout = 8000,
    onSuccess,
    onError,
  } = options;

  const [state, setState] = useState<QueryState<T>>({
    data: null,
    loading: true,
    error: null,
    status: "idle",
  });

  const retryCount = useRef(0);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const execute = useCallback(async () => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null, status: "idle" });
      return;
    }

    // Abort any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    setState(prev => ({ ...prev, loading: true, error: null, status: "loading" }));

    try {
      const { data, error } = await queryFn(controller.signal);

      clearTimeout(timeoutId);

      if (!mountedRef.current) return;

      if (error) {
        // Auto-retry with exponential backoff
        if (retryCount.current < retry) {
          retryCount.current += 1;
          const backoffDelay = retryDelay * Math.pow(2, retryCount.current - 1);
          setTimeout(execute, backoffDelay);
          return;
        }

        setState({
          data: null,
          loading: false,
          error: error.message,
          status: "error",
        });
        onError?.(error.message);
        return;
      }

      retryCount.current = 0;
      setState({
        data,
        loading: false,
        error: null,
        status: "success",
      });
      onSuccess?.(data);
    } catch (err) {
      clearTimeout(timeoutId);

      if (!mountedRef.current) return;

      // Check if it was an abort (timeout or manual cancel)
      if (err instanceof DOMException && err.name === "AbortError") {
        // Retry on timeout if retries remain
        if (retryCount.current < retry) {
          retryCount.current += 1;
          const backoffDelay = retryDelay * Math.pow(2, retryCount.current - 1);
          setTimeout(execute, backoffDelay);
          return;
        }
        setState({
          data: null,
          loading: false,
          error: `Query timed out after ${timeout}ms`,
          status: "error",
        });
        onError?.(`Query timed out after ${timeout}ms`);
        return;
      }

      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setState({
        data: null,
        loading: false,
        error: errorMessage,
        status: "error",
      });
      onError?.(errorMessage);
    }
  }, [enabled, retry, retryDelay, timeout, ...deps]);

  useEffect(() => {
    mountedRef.current = true;
    execute();
    return () => {
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [execute]);

  const refetch = useCallback(() => {
    retryCount.current = 0;
    execute();
  }, [execute]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refetch,
    isIdle: state.status === "idle",
    isLoading: state.status === "loading",
    isSuccess: state.status === "success",
    isError: state.status === "error",
  };
}

// ─── useSupabaseMutation Hook ───
export function useSupabaseMutation<T = any>(
  mutationFn: () => Promise<{ data: T | null; error: PostgrestError | null }>,
  options: {
    onSuccess?: (data: T) => void;
    onError?: (error: PostgrestError) => void;
  } = {}
) {
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });

  const execute = useCallback(async () => {
    setState({ loading: true, error: null });

    try {
      const { data, error } = await mutationFn();

      if (error) {
        setState({ loading: false, error: error.message });
        options.onError?.(error);
        return { data: null, error };
      }

      setState({ loading: false, error: null });
      options.onSuccess?.(data as T);
      return { data, error: null };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setState({ loading: false, error: errorMsg });
      return { data: null, error: errorMsg };
    }
  }, []);

  return {
    execute,
    ...state,
    isLoading: state.loading,
  };
}
