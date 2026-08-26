/**
 * Unit-test setup.
 *
 * Seed the client-side locale cache with every message bundle. In
 * production only EN ships statically; the active locale arrives as an
 * RSC prop from the root layout and other locales load via dynamic
 * import on switch (see `src/lib/i18n/load-locale.ts`). Tests mount
 * `I18nProvider` standalone — often with `renderToStaticMarkup`, which
 * is synchronous and cannot await a dynamic import — so the cache is
 * primed up front and `t()` resolves every locale on the first render,
 * exactly like the server-handoff path does in the app.
 */
import { primeMessages } from "@/lib/i18n/load-locale";
import deMessages from "./messages/de.json";
import enMessages from "./messages/en.json";
import esMessages from "./messages/es.json";
import frMessages from "./messages/fr.json";
import itMessages from "./messages/it.json";
import plMessages from "./messages/pl.json";
import koMessages from "./messages/ko.json";

primeMessages("de", deMessages);
primeMessages("en", enMessages);
primeMessages("es", esMessages);
primeMessages("fr", frMessages);
primeMessages("it", itMessages);
primeMessages("pl", plMessages);
primeMessages("ko", koMessages);
