// Every API route, in one list the router is built from.
import { CONTACTS_ROUTES } from "./contactsRoutes.js";
import { ARCHIVE_ROUTES } from "./archiveRoutes.js";
import { ASSISTANT_ROUTES } from "./assistantRoutes.js";
import { SYSTEM_ROUTES } from "./systemRoutes.js";
import { INTEL_ROUTES } from "./intelRoutes.js";

export const API_ROUTES = [...CONTACTS_ROUTES, ...ARCHIVE_ROUTES, ...ASSISTANT_ROUTES, ...SYSTEM_ROUTES, ...INTEL_ROUTES];
