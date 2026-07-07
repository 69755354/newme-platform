"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

interface ErrorStateProps {
  message?: string;
  retryText?: string;
  onRetry?: () => void;
}

export function ErrorState({
  message = "Load failed, please retry",
  retryText = "Retry",
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
      <AlertTriangle className="w-8 h-8 text-destructive" />
      <p className="text-sm">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/85 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {retryText}
        </button>
      )}
    </div>
  );
}
