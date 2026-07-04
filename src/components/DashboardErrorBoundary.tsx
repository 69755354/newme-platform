"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import Link from "next/link";

// ─── Types ───
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  resetKeys?: any[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  errorId: string | null;
}

// ─── DashboardErrorBoundary ───
// React class component error boundary with Sentry integration.
// Generates a unique errorId for each error to help users report issues
// and for correlating with Sentry events.
export class DashboardErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Generate unique errorId for tracking
    const errorId = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    this.setState({ errorInfo, errorId });

    // Log to console
    console.error("[DashboardErrorBoundary] Caught error:", error);
    console.error("[DashboardErrorBoundary] Error ID:", errorId);
    console.error("[DashboardErrorBoundary] Component stack:", errorInfo.componentStack);

    // Call external error handler
    this.props.onError?.(error, errorInfo);

    // Send to Sentry with errorId for correlation
    Sentry.captureException(error, {
      extra: {
        errorId,
        componentStack: errorInfo.componentStack,
        errorBoundary: true,
      },
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset error state when resetKeys change
    if (this.state.hasError && this.props.resetKeys) {
      const hasChanged = this.props.resetKeys.some(
        (key, index) => key !== prevProps.resetKeys?.[index]
      );
      if (hasChanged) {
        this.reset();
      }
    }
  }

  reset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      errorId: null,
    });
  };

  handleRefresh = (): void => {
    this.reset();
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Custom fallback
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI with errorId for support
      return (
        <div className="error-boundary-fallback">
          <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center space-y-6">
            {/* Error Icon */}
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-destructive"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>

            {/* Error Message */}
            <div className="space-y-2">
              <h2 className="text-xl font-semibold text-foreground">
                页面出现错误
              </h2>
              <p className="text-muted-foreground max-w-md">
                发生了意外错误。请尝试刷新页面，如果问题仍然存在请联系技术支持。
              </p>
            </div>

            {/* Error ID for support */}
            {this.state.errorId && (
              <div className="bg-muted/50 rounded-lg px-4 py-2 font-mono text-sm text-muted-foreground">
                错误编号: <span className="text-foreground font-semibold">{this.state.errorId}</span>
              </div>
            )}

            {/* Error details in development */}
            {process.env.NODE_ENV === "development" && this.state.error && (
              <details className="w-full max-w-lg text-left">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                  错误详情 (开发模式)
                </summary>
                <pre className="mt-2 p-3 bg-muted rounded-lg text-xs overflow-auto max-h-48 text-destructive">
                  {this.state.error.toString()}
                  {"\n\n"}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            {/* Action Buttons */}
            <div className="flex items-center gap-3">
              <Button
                variant="default"
                onClick={this.handleRefresh}
                className="gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                刷新页面
              </Button>

              <Link prefetch={false} href="/">
                <Button variant="outline" className="gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                  返回首页
                </Button>
              </Link>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ─── withErrorBoundary HOC ───
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, "children">
): React.FC<P> {
  return function WithErrorBoundary(props: P) {
    return (
      <DashboardErrorBoundary {...errorBoundaryProps}>
        <Component {...props} />
      </DashboardErrorBoundary>
    );
  };
}
