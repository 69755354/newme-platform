;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="45e0c818-3e0e-470b-a7c6-897313d3cad1")}catch(e){}}();
module.exports=[60284,a=>{"use strict";async function b(a){try{let b=await fetch("/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(a)});if(!b.ok){let a=await b.json().catch(()=>({}));console.warn("[notify] Failed:",b.status,a)}}catch(a){console.warn("[notify] Network error:",a)}}a.s(["notify",0,b])}];

//# debugId=45e0c818-3e0e-470b-a7c6-897313d3cad1
//# sourceMappingURL=newme-platform_src_lib_notify_ts_0a4kh2~._.js.map