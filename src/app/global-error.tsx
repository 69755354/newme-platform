"use client";

/**
 * Global error boundary — catches errors that escape the root layout.
 * This is Next.js's fallback for errors in the root layout itself.
 * It CANNOT use <html> or <body> — Next.js renders those automatically.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="min-h-screen flex items-center justify-center bg-[#F5F3EF] font-sans">
          <div className="max-w-md mx-auto p-8 text-center">
            <div className="text-6xl mb-4">💥</div>
            <h1 className="text-xl font-semibold text-gray-800 mb-2">
              Application Error
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              A critical error occurred. Please refresh the page.
            </p>
            <button
              onClick={reset}
              className="px-6 py-2 bg-[#E5007E] text-white rounded-lg hover:bg-[#C4006B] transition-colors text-sm font-medium"
            >
              Try Again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
