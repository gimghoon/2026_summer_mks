"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/rooms", label: "대화방", icon: "◌" },
  { href: "/profiles", label: "친구 프로필", icon: "◎" },
  { href: "/settings", label: "설정", icon: "⚙" },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav" aria-label="주요 메뉴">
      {items.map((item) => {
        const active = item.href === "/rooms" ? pathname.startsWith("/rooms") : pathname === item.href;
        return (
          <Link className={active ? "bottom-nav__item is-active" : "bottom-nav__item"} href={item.href} key={item.label}>
            <span aria-hidden="true">{item.icon}</span><span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
