#!/usr/bin/env python
"""Assign ownerless projects (user_id IS NULL) to a user.

Part of the `project-ownership` work. Projects gained a nullable `user_id`
column; existing rows stay NULL (the legacy/guest bucket, still reachable while
signed out). This optional one-off tool hands those legacy projects to a chosen
user so they show up under that account once ownership scoping is enabled.

Not running it is fine — ownerless projects simply remain in the guest bucket.

Usage:
    python scripts/backfill_project_owner.py --user-email someone@example.com
    python scripts/backfill_project_owner.py --user-id 1
    python scripts/backfill_project_owner.py --user-id 1 --dry-run
    python scripts/backfill_project_owner.py --list-users

Env (backend/.env): DATABASE_URL (defaults to the local sqlite file).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_BACKEND_ROOT / ".env")
sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import func, select, update  # noqa: E402

from app.db.database import AsyncSessionLocal  # noqa: E402
from app.db.orm_models import DBProject, DBUser  # noqa: E402


async def _list_users() -> None:
    async with AsyncSessionLocal() as session:
        users = (await session.execute(select(DBUser).order_by(DBUser.id))).scalars().all()
        if not users:
            print("No users yet — sign in once to create a user row.")
            return
        for u in users:
            print(f"  id={u.id}  provider={u.provider}  email={u.email}  name={u.name}")


async def _resolve_user_id(
    session, user_id: int | None, user_email: str | None
) -> int:
    if user_id is not None:
        user = await session.get(DBUser, user_id)
        if user is None:
            raise SystemExit(f"No user with id={user_id}. Try --list-users.")
        return user.id
    # by email
    user = (
        await session.execute(select(DBUser).where(DBUser.email == user_email))
    ).scalar_one_or_none()
    if user is None:
        raise SystemExit(f"No user with email={user_email!r}. Try --list-users.")
    return user.id


async def _run(args: argparse.Namespace) -> None:
    if args.list_users:
        await _list_users()
        return

    if args.user_id is None and not args.user_email:
        raise SystemExit("Provide --user-id or --user-email (or --list-users).")

    async with AsyncSessionLocal() as session:
        target_id = await _resolve_user_id(session, args.user_id, args.user_email)

        n_orphans = (
            await session.execute(
                select(func.count())
                .select_from(DBProject)
                .where(DBProject.user_id.is_(None))
            )
        ).scalar_one()

        if n_orphans == 0:
            print("No ownerless projects (user_id IS NULL) to assign.")
            return

        if args.dry_run:
            rows = (
                await session.execute(
                    select(DBProject.id, DBProject.name).where(DBProject.user_id.is_(None))
                )
            ).all()
            print(f"[dry-run] Would assign {n_orphans} project(s) to user_id={target_id}:")
            for pid, name in rows:
                print(f"  - #{pid} {name!r}")
            return

        await session.execute(
            update(DBProject).where(DBProject.user_id.is_(None)).values(user_id=target_id)
        )
        await session.commit()
        print(f"Assigned {n_orphans} ownerless project(s) to user_id={target_id}.")


def main() -> None:
    p = argparse.ArgumentParser(description="Assign ownerless projects to a user.")
    p.add_argument("--user-id", type=int, default=None, help="Target user id.")
    p.add_argument("--user-email", type=str, default=None, help="Target user email.")
    p.add_argument("--list-users", action="store_true", help="List users and exit.")
    p.add_argument("--dry-run", action="store_true", help="Show what would change, write nothing.")
    asyncio.run(_run(p.parse_args()))


if __name__ == "__main__":
    main()
