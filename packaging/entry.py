"""PyInstaller entry point for the desktop bundle (SawtSakinah.exe)."""

import multiprocessing
import sys

if __name__ == "__main__":
    # A frozen child process (spawn) must branch off here, before the app imports.
    multiprocessing.freeze_support()

    from sawt_sakinah.desktop import main

    sys.exit(main())
