"use client";

import { createContext } from "react";
import type { SessionHandoff } from "./session-handoff";
import type { PageIdentity } from "./page-identity";
import type { SessionIdentity } from "./session-identity";

/** Provided by the dashboard layout: its fresh identity read, for the first page. */
export const SessionHandoffContext = createContext<SessionHandoff<SessionIdentity> | null>(null);

/** Provided by a page that resolved its role: its components need not ask again. */
export const PageIdentityContext = createContext<PageIdentity | null>(null);
