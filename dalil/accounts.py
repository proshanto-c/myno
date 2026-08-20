"""
Reviewer accounts, from the command line. There is no signup endpoint.

    docker compose exec dalil python accounts.py list
    docker compose exec dalil python accounts.py add   --email a@b.ac.uk --name "Ada"
    docker compose exec dalil python accounts.py passwd --email a@b.ac.uk
    docker compose exec dalil python accounts.py disable --email a@b.ac.uk
"""
import argparse
import datetime as dt
import getpass
import sys

import auth
from models import Reviewer, Session, init_db


def _ask_password() -> str:
    first = getpass.getpass("password: ")
    if len(first) < 12:
        sys.exit("A reviewer password must be at least 12 characters.")
    if first != getpass.getpass("again: "):
        sys.exit("They didn't match.")
    return first


def main():
    parser = argparse.ArgumentParser(description="Dalīl reviewer accounts")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("add", "passwd", "disable", "enable"):
        p = sub.add_parser(name)
        p.add_argument("--email", required=True)
        if name == "add":
            p.add_argument("--name", default="")
            p.add_argument("--role", default="reviewer", choices=["reviewer", "admin"])
    sub.add_parser("list")
    args = parser.parse_args()

    init_db()
    s = Session()
    try:
        if args.cmd == "list":
            for r in s.query(Reviewer).order_by(Reviewer.id).all():
                state = "disabled" if r.disabled_at else "active"
                print(f"{r.id:>3}  {r.email:<34} {r.role:<9} {state}")
            return

        email = args.email.lower().strip()
        existing = s.query(Reviewer).filter(Reviewer.email == email).first()

        if args.cmd == "add":
            if existing:
                sys.exit(f"{email} already exists.")
            s.add(Reviewer(email=email, name=args.name or email.split("@")[0],
                           role=args.role, password_hash=auth.hash_password(_ask_password())))
            s.commit()
            print(f"added {email}")
            return

        if not existing:
            sys.exit(f"No account for {email}.")
        if args.cmd == "passwd":
            existing.password_hash = auth.hash_password(_ask_password())
        elif args.cmd == "disable":
            existing.disabled_at = dt.datetime.utcnow()
        elif args.cmd == "enable":
            existing.disabled_at = None
        s.commit()
        print(f"{args.cmd} {email}")
    finally:
        s.close()


if __name__ == "__main__":
    main()
