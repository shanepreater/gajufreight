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
-define(FACTORY,   "ct_2vpnb3xS4K9SsiWywTNgTMNNRr88eMFgoiVxT6hjKhJS3iMJ1Y").

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
    EAACI = hz_aaci:prepare(maps:get(aci, Escrow)),
    FAACI = hz_aaci:prepare(maps:get(aci, Factory)),
    log("runner", Me, #{balance => balance(Me)}),

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
    {Pay3, _} = call(Me, Sec, EAACI, Esc, 0, "pay", [?FACTORY, "1"]),
    log("E6b pay non-payable contract", Pay3, #{}),

    %% E8: the contract's blake2b of a record, reproduced off-chain.
    {FpTx, OnChain} = call(Me, Sec, EAACI, Esc, 0, "fingerprint", ["{price = 100, location = \"NLRTM\"}"]),
    Fate = gmb_fate_encoding:serialize({tuple, {100, <<"NLRTM">>}}),
    {ok, OffChain} = eblake2:blake2b(32, Fate),
    log("E8 blake2b", FpTx, #{on_chain => OnChain, off_chain => {bytes, OffChain},
                             match => OnChain =:= {bytes, OffChain}}),

    %% E3: Chain.create from a contract, funded in the same call.
    {MakeTx, Child} = call(Me, Sec, FAACI, ?FACTORY, ?X, "make", []),
    ChildId = contract_id(Child),
    log("E3 make", MakeTx, #{child => ChildId, balance => balance(ChildId),
                             contract => contract(ChildId)}),

    %% E4: Chain.clone of that child, funded in the same call.
    {CloneTx, Clone} = call(Me, Sec, FAACI, ?FACTORY, ?X, "clone_funded", [ChildId]),
    CloneId = contract_id(Clone),
    log("E4 clone", CloneTx, #{clone => CloneId, balance => balance(CloneId),
                               contract => contract(CloneId)}),
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

call(Me, Sec, AACI, Con, Amount, Fun, Args) ->
    {ok, Nonce} = hz:next_nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_call(Me, Nonce, 5000000, 1000000000, Amount, Height + 1000,
                                AACI, Con, Fun, {sophia, Args}),
    Info = submit(Tx, Sec),
    #{"return_value" := RV} = maps:get("call_info", Info),
    {ok, Value} = hz:decode_bytearray_fate(RV),
    {maps:get("tx_hash", Info), Value}.

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

balance(Id) ->
    case hz:acc(Id) of
        {ok, #{"balance" := B}} -> B;
        _                       -> 0
    end.

log(Label, Ref, Map) ->
    io:format("~s [~s]~n  ~p~n", [Label, Ref, Map]).
