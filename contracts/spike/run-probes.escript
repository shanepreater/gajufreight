#!/usr/bin/env escript
%% Phase 0 spike runner (docs/spikes/phase-0-testnet.md). Not a test harness yet.
%%
%% Runs E2-E8 and E10 on Groot testnet with a throwaway key and prints the evidence.
%% Uses the Hakuzaru and Sophia that GajuDesk installs. The key file is an Erlang term
%% {Pub, Sec} kept outside the repo; never commit it.
%%
%%   ZOMP_DIR=~/.zx/zomp escript contracts/spike/run-probes.escript <key-file>

-define(NODE, {"groot.testnet.gajumaru.io", 3013}).
-define(X, 1000000000000000).   % 0.001 Gaju in puck
-define(COURIER,   "ak_2qUaM6oGvVFiDboExbhtXRo5FBwUPUuH2baWaaGs2prJAU1Zv9").
-define(COURIER02, "ak_2srNcriPqhuTdEFLXwHBJqaLudA2LA2Pz5C29aEjGviYbDRF8x").

main([KeyFile]) ->
    Zomp = os:getenv("ZOMP_DIR", filename:join(os:getenv("HOME"), ".zx/zomp")),
    ok = code:add_paths(latest_ebins(filename:join(Zomp, "lib/otpr"))),
    {ok, _} = application:ensure_all_started(hakuzaru),
    ok = hz:chain_nodes([?NODE]),
    {ok, Bin} = file:read_file(KeyFile),
    {Pub, Sec} = binary_to_term(Bin),
    Me = binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)),
    Dir = filename:dirname(escript:script_name()),
    {ok, Escrow} = so_compiler:file(filename:join(Dir, "probe-escrow.aes"), [{aci, json}]),
    {ok, Factory} = so_compiler:file(filename:join(Dir, "probe-factory.aes"), [{aci, json}]),
    {ok, Caller} = so_compiler:file(filename:join(Dir, "probe-caller.aes"), [{aci, json}]),
    CAACI = hz_aaci:prepare(maps:get(aci, Caller)),
    EAACI = hz_aaci:prepare(maps:get(aci, Escrow)),
    FAACI = hz_aaci:prepare(maps:get(aci, Factory)),
    %% Three funded calls of X plus gas; an unfunded account would otherwise post a
    %% transaction that is never mined and wait for it.
    Funds = balance(Me),
    log("runner", Me, #{balance => Funds}),
    Funds >= 4 * ?X orelse error({insufficient_balance, Me, Funds, need_at_least, 4 * ?X}),
    {FacTx, Fac} = create(Me, Sec, Factory, 0, []),
    log("factory create", FacTx, #{contract => Fac}),

    %% E2: created and funded in one transaction.
    {CreateTx, Esc} = create(Me, Sec, Escrow, ?X, [integer_to_list(?X)]),
    log("E2 create", CreateTx, #{contract => Esc, balance => balance(Esc), expected => ?X}),
    e7_events("E7 create events", CreateTx, ["Funded"]),

    %% E5 + E10: dry-run estimate, then the real call.
    Est = dry_gas(Me, EAACI, Esc, "bump", []),
    {BumpTx, _} = call(Me, Sec, EAACI, Esc, 0, "bump", []),
    log("E10 bump estimate vs actual", BumpTx, #{dry_run_gas => Est}),
    e7_events("E7 bump events", BumpTx, ["Counted"]),

    %% E6: payouts with no co-signature; E6b: a non-payable contract refuses one.
    B1 = balance(?COURIER), B2 = balance(?COURIER02),
    {Pay1, _} = call(Me, Sec, EAACI, Esc, 0, "pay", [?COURIER, integer_to_list(?X div 4)]),
    {Pay2, _} = call(Me, Sec, EAACI, Esc, 0, "pay", [?COURIER02, integer_to_list(?X div 4)]),
    log("E6 payouts", Pay1, #{courier_delta => balance(?COURIER) - B1,
                              courier02_delta => balance(?COURIER02) - B2,
                              escrow_left => balance(Esc), second_tx => Pay2}),
    {Pay3, Why} = call_revert(Me, Sec, EAACI, Esc, 0, "pay", [Fac, "1"]),
    log("E6b pay non-payable contract (must revert)", Pay3, #{reason => Why}),

    %% E8: the contract's blake2b of a record, reproduced off-chain.
    {FpTx, OnChain} = call(Me, Sec, EAACI, Esc, 0, "fingerprint", ["{price = 100, location = \"NLRTM\"}"]),
    Fate = gmb_fate_encoding:serialize({tuple, {100, <<"NLRTM">>}}),
    {ok, OffChain} = eblake2:blake2b(32, Fate),
    log("E8 blake2b", FpTx, #{on_chain => OnChain, off_chain => {bytes, OffChain},
                             match => OnChain =:= {bytes, OffChain}}),

    %% E3: Chain.create from a contract, funded in the same call.
    {MakeTx, Child} = call(Me, Sec, FAACI, Fac, ?X, "make", []),
    ChildId = contract_id(Child),
    log("E3 make", MakeTx, #{child => ChildId, balance => balance(ChildId),
                             contract => contract(ChildId)}),

    %% E4: Chain.clone of that child, funded in the same call.
    {CloneTx, Clone} = call(Me, Sec, FAACI, Fac, ?X, "clone_funded", [ChildId]),
    CloneId = contract_id(Clone),
    log("E4 clone", CloneTx, #{clone => CloneId, balance => balance(CloneId),
                               contract => contract(CloneId)}),

    %% E11: a clone has the same bytecode hash as its template; a plain account has none.
    {_, ChildHash} = call(Me, Sec, FAACI, Fac, 0, "code_hash", [ChildId]),
    {HashTx, CloneHash} = call(Me, Sec, FAACI, Fac, 0, "code_hash", [CloneId]),
    {_, EscHash} = call(Me, Sec, FAACI, Fac, 0, "code_hash", [Esc]),
    log("E11 bytecode_hash", HashTx, #{child => ChildHash, clone => CloneHash, other_contract => EscHash,
                                       clone_matches_template => ChildHash =:= CloneHash,
                                       differs_from_other => ChildHash =/= EscHash}),

    %% E11b: the factory reads ProbeCaller's hash while ProbeCaller is still in init.
    {CallerTx, CallerId} = create(Me, Sec, Caller, 0, [Fac]),
    {_, Seen} = call(Me, Sec, CAACI, CallerId, 0, "seen", []),
    {_, Actual} = call(Me, Sec, FAACI, Fac, 0, "code_hash", [CallerId]),
    log("E11b caller hash during init", CallerTx, #{seen_in_init => Seen, actual => Actual,
                                                    match => Seen =:= Actual andalso Seen =/= none}),
    log("runner", Me, #{balance => balance(Me)}),
    ok;
main(_) ->
    io:format("usage: run-probes.escript <key-file>~n"),
    halt(1).

%% zx keeps old versions side by side (hakuzaru 0.6.1 and 0.9.1); load only the newest.
latest_ebins(Lib) ->
    Version = fun(V) -> [list_to_integer(P) || P <- string:split(V, ".", all)] end,
    [filename:join([Lib, App, lists:last(lists:sort(fun(A, B) -> Version(A) =< Version(B) end,
                                                    filelib:wildcard("*", filename:join(Lib, App)))),
                    "ebin"])
     || App <- filelib:wildcard("*", Lib)].

create(Me, Sec, Built, Amount, Args) ->
    {ok, Nonce} = hz:next_nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_create_built(Me, Nonce, 5000000, 1000000000, Amount, Height + 1000,
                                        Built, {sophia, Args}),
    Info = submit(Tx, Sec),
    {maps:get("tx_hash", Info), maps:get("contract_id", maps:get("call_info", Info))}.

%% A call that must succeed: a revert stops the run with its reason.
call(Me, Sec, AACI, Con, Amount, Fun, Args) ->
    case try_call(Me, Sec, AACI, Con, Amount, Fun, Args) of
        {Hash, {ok, Value}}      -> {Hash, Value};
        {Hash, {revert, Reason}} -> error({unexpected_revert, Fun, Hash, Reason})
    end.

%% A call that must revert (a negative probe): returns its hash and the revert reason.
call_revert(Me, Sec, AACI, Con, Amount, Fun, Args) ->
    case try_call(Me, Sec, AACI, Con, Amount, Fun, Args) of
        {Hash, {revert, Reason}} -> {Hash, Reason};
        {Hash, {ok, Value}}      -> error({unexpected_success, Fun, Hash, Value})
    end.

try_call(Me, Sec, AACI, Con, Amount, Fun, Args) ->
    {ok, Nonce} = hz:next_nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_call(Me, Nonce, 5000000, 1000000000, Amount, Height + 1000,
                                AACI, Con, Fun, {sophia, Args}),
    Info = submit(Tx, Sec),
    #{"return_type" := Type, "return_value" := RV} = maps:get("call_info", Info),
    Result = case Type of
                 "ok"     -> {ok, decode(RV)};
                 "revert" -> {revert, decode(RV)};
                 Other    -> error({unexpected_return_type, Fun, Other})
             end,
    {maps:get("tx_hash", Info), Result}.

%% hz 0.9.1 doesn't export a FATE decoder, so decode the "cb_..." value directly.
%% A unit return (e.g. init) is empty.
decode(Encoded) ->
    {ok, Bin} = gmser_api_encoder:safe_decode(contract_bytearray, list_to_binary(Encoded)),
    case Bin of
        <<>> -> unit;
        _    -> gmb_fate_encoding:deserialize(Bin)
    end.

submit(Tx, Sec) ->
    {ok, NetworkID} = hz:network_id(),
    Signed = hz:sign_tx(Tx, Sec, NetworkID),
    {ok, #{"tx_hash" := Hash}} = hz:post_tx(Signed),
    wait(Hash, 60).

wait(Hash, 0) -> error({not_mined, Hash});
wait(Hash, N) ->
    case hz:tx_info(Hash) of
        {ok, Info = #{"call_info" := CI}} ->
            io:format("  ~s ~s gas ~p~n", [Hash, maps:get("return_type", CI), maps:get("gas_used", CI)]),
            Info#{"tx_hash" => Hash};
        _ ->
            timer:sleep(3000),
            wait(Hash, N - 1)
    end.

%% The public testnet nodes answer dry runs with "Internal server error" (2026-10-05),
%% so E10 records whatever comes back.
dry_gas(Me, AACI, Con, Fun, Args) ->
    case dry(Me, AACI, Con, Fun, Args) of
        {ok, #{"call_obj" := #{"gas_used" := Gas}}} -> Gas;
        Other                                      -> Other
    end.

dry(Me, AACI, Con, Fun, Args) ->
    {ok, Nonce} = hz:next_nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_call(Me, Nonce, 5000000, 1000000000, 0, Height + 1000,
                                AACI, Con, Fun, {sophia, Args}),
    case hz:dry_run(Tx) of
        {ok, #{"results" := [R]}} -> {ok, R};
        Other                     -> {error, Other}
    end.

%% E7: each event's first topic is blake2b of the constructor name, so an indexer
%% can recognise events without the contract source.
e7_events(Label, Hash, Names) ->
    {ok, #{"call_info" := #{"log" := Log}}} = hz:tx_info(Hash),
    Expected = [binary:decode_unsigned(element(2, eblake2:blake2b(32, list_to_binary(N))))
                || N <- Names],
    Topics = [hd(maps:get("topics", L)) || L <- Log],
    log(Label, Hash, #{log => Log, names_match_topics => Topics =:= Expected}).

contract_id({contract, Pub}) -> binary_to_list(gmser_api_encoder:encode(contract_pubkey, Pub)).

contract(Id) ->
    case hz:contract(Id) of
        {ok, C} -> maps:with(["active", "owner_id", "referrer_ids"], C);
        Error   -> Error
    end.

%% An account that has never received funds doesn't exist yet, so it holds 0. Any other
%% error stops the run rather than passing for a zero balance.
balance(Id) ->
    case hz:acc(Id) of
        {ok, #{"balance" := B}}        -> B;
        {error, "Account not found"} -> 0;
        Error                          -> error({balance_unavailable, Id, Error})
    end.

log(Label, Ref, Map) ->
    io:format("~s [~s]~n  ~p~n", [Label, Ref, Map]).
