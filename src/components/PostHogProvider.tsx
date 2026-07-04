"use client";

import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";

const PUBLIC_PATHS = ["/login", "/change-password"];

const PostHogProviderInner = dynamic(
  () => import("./PostHogProviderInner"),
  { ssr: false }
);

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (
    PUBLIC_PATHS.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    )
  ) {
    return <>{children}</>;
  }

  return <PostHogProviderInner>{children}</PostHogProviderInner>;
}
