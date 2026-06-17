"use client";

import { useState, useEffect } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { Maximize2, Minimize2 } from "lucide-react";

export default function GamesPage() {
  const { t } = useLanguage();
  const [fullscreen, setFullscreen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (fullscreen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [fullscreen]);

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 bg-[#1a1a2e] flex flex-col" : "h-full flex flex-col"}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-black/30 border-b border-white/10 flex-shrink-0">
        <h1 className="text-lg font-bold text-[#e8c547]">掼蛋</h1>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="p-1.5 rounded hover:bg-white/10 transition-colors"
          title={fullscreen ? "退出全屏" : "全屏"}
        >
          {fullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Game iframe */}
      <div className="flex-1 relative">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a2e] text-white/60 text-sm">
            加载中...
          </div>
        )}
        <iframe
          src="/guandan.html"
          className="w-full h-full border-0"
          onLoad={() => setLoaded(true)}
          title="掼蛋"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
