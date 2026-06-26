VerifyHash challenge sample packet
==================================

This folder is a sealed "packet" of files. The file `seal.vhevidence.json`
in the parent folder commits to the EXACT bytes of every file here.

Change a single byte in any file under this folder and the independent,
zero-install verifier will REJECT the packet and point at the file you changed.
