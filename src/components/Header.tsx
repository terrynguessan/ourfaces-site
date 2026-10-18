"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  equivalentLanguagePath,
  localeFromPathname,
  localizedPath,
  stripLocalePrefix,
} from "@/lib/i18n";

const links = [
  { key: "home", href: "/", en: "Home", fr: "Accueil", cta: false },
  { key: "technology", href: "/technology", en: "Technology", fr: "Technologie", cta: false },
  { key: "business", href: "/business", en: "Business", fr: "Affaires", cta: false },
  { key: "insights", href: "/insights", en: "Insights", fr: "Perspectives", cta: false },
  { key: "about", href: "/about", en: "About", fr: "À propos", cta: false },
  { key: "contact", href: "/contact", en: "Contact", fr: "Contact", cta: true },
] as const;

const pageOrder = links.map((link) => link.href);

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = localeFromPathname(pathname);
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navLinksRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      if (
        menuButtonRef.current?.contains(target) ||
        navLinksRef.current?.contains(target)
      ) {
        return;
      }

      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    let startX: number | null = null;
    let startY: number | null = null;
    let startedAt = 0;

    const isInteractiveTarget = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(
        target.closest(
          "a, button, input, textarea, select, option, label, [role='button'], [data-no-swipe]",
        ),
      );

    const reset = () => {
      startX = null;
      startY = null;
      startedAt = 0;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (
        open ||
        !window.matchMedia("(max-width: 760px)").matches ||
        event.touches.length !== 1 ||
        isInteractiveTarget(event.target)
      ) {
        reset();
        return;
      }

      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startedAt = Date.now();
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (startX === null || startY === null || event.changedTouches.length !== 1) {
        reset();
        return;
      }

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const elapsed = Date.now() - startedAt;
      reset();

      const horizontalDistance = Math.abs(deltaX);
      const verticalDistance = Math.abs(deltaY);

      if (
        horizontalDistance < 72 ||
        horizontalDistance < verticalDistance * 1.25 ||
        elapsed > 900
      ) {
        return;
      }

      const currentPath = stripLocalePrefix(pathname);
      const currentIndex = pageOrder.indexOf(currentPath as (typeof pageOrder)[number]);
      if (currentIndex < 0) return;

      const targetIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
      if (targetIndex < 0 || targetIndex >= pageOrder.length) return;

      router.push(localizedPath(locale, pageOrder[targetIndex]));
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [locale, open, pathname, router]);


  const navLabel = locale === "fr" ? "Navigation principale" : "Primary navigation";
  const homeLabel = locale === "fr" ? "Accueil OurFaces" : "OurFaces home";
  const skipLabel = locale === "fr" ? "Aller au contenu principal" : "Skip to main content";
  const menuLabel = open
    ? locale === "fr" ? "Fermer le menu" : "Close menu"
    : locale === "fr" ? "Ouvrir le menu" : "Open menu";

  // Rendered in the desktop nav and, when the nav collapses, in the header bar
  // itself so the language choice stays visible without opening the menu.
  const renderLanguageSwitch = (className: string) => (
    <div className={className} role="group" aria-label={locale === "fr" ? "Langue" : "Language"}>
      <Link
        href={equivalentLanguagePath(pathname, "en")}
        className={locale === "en" ? "language-option active" : "language-option"}
        aria-current={locale === "en" ? "page" : undefined}
        aria-label="English"
        lang="en"
        hrefLang="en"
        onClick={() => setOpen(false)}
      >
        EN
      </Link>
      <span className="language-separator" aria-hidden="true">|</span>
      <Link
        href={equivalentLanguagePath(pathname, "fr")}
        className={locale === "fr" ? "language-option active" : "language-option"}
        aria-current={locale === "fr" ? "page" : undefined}
        aria-label="Français"
        lang="fr"
        hrefLang="fr"
        onClick={() => setOpen(false)}
      >
        FR
      </Link>
    </div>
  );

  return (
    <header className="site-header" lang={locale}>
      <a className="skip-link" href="#main-content">{skipLabel}</a>
      <nav className="shell site-nav" aria-label={navLabel}>
        <Link
          className="brand"
          href={localizedPath(locale, "/")}
          aria-label={homeLabel}
          onClick={() => setOpen(false)}
        >
          <img
            className="brand-logo"
            src="/assets/ourfaces-logo-564.png"
            width={564}
            height={184}
            alt="OurFaces — Import Export, LLC"
          />
        </Link>

        {renderLanguageSwitch("language-switch language-switch-mobile")}

        <button
          ref={menuButtonRef}
          className="menu-btn"
          type="button"
          aria-expanded={open}
          aria-controls="primary-nav-links"
          aria-label={menuLabel}
          onClick={() => setOpen((value) => !value)}
        >
          Menu
        </button>

        <div
          ref={navLinksRef}
          className={`nav-links${open ? " open" : ""}`}
          id="primary-nav-links"
        >
          {links.map((link) => {
            const href = localizedPath(locale, link.href);
            const active = pathname === href;
            return (
              <Link
                key={link.href}
                href={href}
                className={`${link.cta ? "nav-cta " : "nav-link "}${link.cta ? "" : `nav-link-${link.key} `}${active ? "active" : ""}`.trim()}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                {locale === "fr" ? link.fr : link.en}
              </Link>
            );
          })}

          {renderLanguageSwitch("language-switch")}
        </div>
      </nav>
    </header>
  );
}
