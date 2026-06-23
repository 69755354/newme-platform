"use client";

import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global React ErrorBoundary — catches rendering errors in the component tree
 * and shows a fallback UI instead of a white screen.
 * 
 * Reports errors to Sentry and PostHog for tracking.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error.message, errorInfo.componentStack);

    // Report to Sentry
    if (typeof window !== "undefined" && (window as any).Sentry) {
      (window as any).Sentry.captureException(error, {
        contexts: {
          react: {
            componentStack: errorInfo.componentStack,
          },
        },
      });
    }

    // Report to PostHog
    if (typeof window !== "undefined" && (window as any).posthog) {
      (window as any).posthog.capture("$exception", {
        $exception_message: error.message,
        $exception_type: error.name,
        $exception_stack: error.stack,
        component_stack: errorInfo.componentStack,
      });
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F5F3EF]">
          <div className="max-w-md mx-auto p-8 text-center">
            <div className="text-6xl mb-4">⚠️</div>
            <h1 className="text-xl font-semibold text-gray-800 mb-2">
              Something went wrong
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              The page encountered an unexpected error. Please try refreshing.
            </p>
            {this.state.error && (
              <details className="mb-6 text-left">
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
                  Technical details
                </summary>
                <pre className="mt-2 p-3 bg-gray-100 rounded text-xs text-gray-600 overflow-auto max-h-32">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="px-6 py-2 bg-[#4A5568] text-white rounded-lg hover:bg-[#C4006B] transition-colors text-sm font-medium"
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
