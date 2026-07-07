"use client";

import { ErrorBoundary } from "@/views/providers/error-boundary";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F3EF]">
      <div className="max-w-md mx-auto p-8 text-center">
        <div className="text-6xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold text-gray-800 mb-2">
          Something went wrong
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          The application encountered an error. Please try again.
        </p>
        <button
          onClick={reset}
          className="px-6 py-2 bg-[#4A5568] text-white rounded-lg hover:bg-[#334155] transition-colors text-sm font-medium"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
