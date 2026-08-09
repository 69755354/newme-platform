"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

const PIXEL_ID = "1612447067166445";

const NO_PIXEL_PATHS = [
  "/login",
  "/change-password",
  "/ads",
  "/analytics",
  "/command-center",
  "/contracts",
  "/dashboard",
  "/leads",
  "/payments",
  "/pipeline",
  "/products",
  "/projects",
  "/quotations",
  "/quotes",
  "/settings",
  "/tasks",
  "/team",
  "/workbench",
] as const;

function isBackendPath(pathname: string, backendPaths: readonly string[]) {
  return backendPaths.some(
    (backendPath) => pathname === backendPath || pathname.startsWith(`${backendPath}/`),
  );
}

type MetaPixelProps = {
  excludedPaths?: readonly string[];
};

export default function MetaPixel({ excludedPaths = NO_PIXEL_PATHS }: MetaPixelProps) {
  const pathname = usePathname();

  if (isBackendPath(pathname, excludedPaths)) {
    return null;
  }

  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive">
        {`
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${PIXEL_ID}');
fbq('track', 'PageView');
        `}
      </Script>
      <noscript>
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          src={`https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1`}
          alt=""
        />
      </noscript>
    </>
  );
}
