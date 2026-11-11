Optional private `network-session.v1` support carries a caller-owned, short-lived signed namespace
lease through bot spawning and renewal. Qualified Docker runtimes join only a verified isolated
gateway namespace; missing/expired authority and unsupported runtimes refuse the requested route.
The default remains off. Existing meeting uniqueness, authenticated-session affinity and stop
behavior remain in their established paths. Real meeting signaling/media/stop/network-loss acceptance
is required before rollout; unit and payload tests do not prove live meeting behavior.
