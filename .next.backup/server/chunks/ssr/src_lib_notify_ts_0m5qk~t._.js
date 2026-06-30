;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="e854cd34-e12c-d0a9-d084-92a6ab8729da")}catch(e){}}();
module.exports=[513,a=>{"use strict";async function b(a){try{let b=await fetch("/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(a)});if(!b.ok){let a=await b.json().catch(()=>({}));console.warn("[notify] Failed:",b.status,a)}}catch(a){console.warn("[notify] Network error:",a)}}a.s(["notify",0,b])}];

//# debugId=e854cd34-e12c-d0a9-d084-92a6ab8729da
//# sourceMappingURL=src_lib_notify_ts_0m5qk~t._.js.map