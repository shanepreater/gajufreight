"""Typed access to the Gajumaru node HTTP API, shared by GajuFreight services.

The node's HTTP API is the only interface: there is no SDK (HLD §7 Q7). This package
holds what every service needs to read the chain: the client, response models, event
recognition and the per-network finality rule.
"""
