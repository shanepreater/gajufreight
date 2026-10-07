%%% @doc Builds unsigned contract calls and creates, with a fee estimate, for a wallet to
%%% sign over GRIDS. The nonce comes from the account's mined state, never the pending
%%% count, so a transaction that will never be mined can't block later ones (spike).
-module(tx_builder_calls).

-export([call/1, create/1]).

%% Req: contract (ct_...), contract_name, function, args (Sophia literals), caller;
%% optional amount, nonce, ttl (absolute height), gas, dry_run (default true).
call(Req = #{contract := Contract, contract_name := Name, function := Fun, args := Args,
             caller := Caller}) ->
    maybe
        {ok, #{aaci := AACI}} ?= tx_builder_contracts:get(Name),
        {ok, Nonce, TTL} ?= nonce_and_ttl(Caller, Req),
        {ok, Tx} ?= hz:contract_call(Caller, Nonce, gas(Req), gas_price(), amount(Req), TTL,
                                     AACI, Contract, Fun, {sophia, Args}),
        {ok, result(Tx, Nonce, TTL, Req)}
    end.

%% Req: contract_name, args (init's Sophia literals), caller; optional as for call/1.
create(Req = #{contract_name := Name, args := Args, caller := Caller}) ->
    maybe
        {ok, #{built := Built}} ?= tx_builder_contracts:get(Name),
        {ok, Nonce, TTL} ?= nonce_and_ttl(Caller, Req),
        {ok, Tx} ?= hz:contract_create_built(Caller, Nonce, gas(Req), gas_price(), amount(Req),
                                             TTL, Built, {sophia, Args}),
        {ok, result(Tx, Nonce, TTL, Req)}
    end.

nonce_and_ttl(Caller, Req) ->
    maybe
        {ok, Nonce} ?= case maps:find(nonce, Req) of {ok, N} -> {ok, N}; error -> mined_nonce(Caller) end,
        {ok, TTL} ?= case maps:find(ttl, Req) of {ok, T} -> {ok, T}; error -> default_ttl() end,
        {ok, Nonce, TTL}
    end.

mined_nonce(Caller) ->
    case hz:acc(Caller) of
        {ok, #{"nonce" := N}} -> {ok, N + 1};
        {error, "Account not found"} -> {ok, 1};
        {error, Reason} -> {error, {node, Reason}}
    end.

default_ttl() ->
    case hz:top_height() of
        {ok, Height} -> {ok, Height + tx_builder_app:config(ttl_blocks)};
        {error, Reason} -> {error, {node, Reason}}
    end.

result(Tx, Nonce, TTL, Req) ->
    DryGas = case maps:get(dry_run, Req, true) of
                 true -> dry_run_gas(Tx);
                 false -> null
             end,
    Fee = case DryGas of
              null -> null;
              _ -> (DryGas + tx_builder_app:config(fixed_charge_gas)) * gas_price()
          end,
    #{tx => Tx, nonce => Nonce, ttl => TTL, dry_run_gas => DryGas, fee_estimate => Fee}.

%% A dry run gives execution gas only (spike E10, E18). It fails while the caller's
%% account doesn't exist yet; the estimate is then null rather than an error.
%% hz:dry_run/1 also asks for tx_events, which makes testnet's node answer "Internal
%% server error" (2026-10-07), so the request is built here without it.
dry_run_gas(Tx) ->
    Result = case hz:top_block() of
                 {ok, #{"hash" := Top}} ->
                     hz:dry_run_map(#{top => to_binary(Top), accounts => [], txs => [#{tx => to_binary(Tx)}]});
                 Error ->
                     Error
             end,
    case Result of
        {ok, #{"results" := [#{"call_obj" := #{"gas_used" := Gas}}]}} -> Gas;
        _ -> null
    end.

to_binary(Value) when is_binary(Value) -> Value;
to_binary(Value) -> list_to_binary(Value).

gas(Req) -> maps:get(gas, Req, tx_builder_app:config(gas)).
gas_price() -> tx_builder_app:config(gas_price).
amount(Req) -> maps:get(amount, Req, 0).
