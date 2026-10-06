#!/usr/bin/env escript
%% Phase 0 spike runner (docs/spikes/phase-0-testnet.md). Not a test harness yet.
%%
%% Runs the probes on Groot testnet with a throwaway key and prints the evidence.
%% Round 1 (no mode): E2-E8, E10, E11, E11b. Round 2 (`round2`): E12, E14-E17.
%% Uses the Hakuzaru and Sophia that GajuDesk installs. The key file is an Erlang term
%% {Pub, Sec} kept outside the repo; never commit it.
%%
%%   ZOMP_DIR=~/.zx/zomp escript contracts/spike/run-probes.escript <key-file> [round2]
%%
%% E9 (GRIDS dead drop) needs no key here: it builds one unsigned request at a time for the
%% signer's own wallet, then checks and submits what the wallet posts back:
%%
%%   run-probes.escript grids-build book <signer> <out.json> <booker> <template>
%%   run-probes.escript grids-build create <signer> <out.json>
%%   run-probes.escript grids-build message <signer> <out.json>
%%   run-probes.escript grids-submit <request.json> <signed.json>

-define(NODE, {"groot.testnet.gajumaru.io", 3013}).
-define(X, 1000000000000000).   % 0.001 Gaju in puck
-define(COURIER,   "ak_2qUaM6oGvVFiDboExbhtXRo5FBwUPUuH2baWaaGs2prJAU1Zv9").
-define(COURIER02, "ak_2srNcriPqhuTdEFLXwHBJqaLudA2LA2Pz5C29aEjGviYbDRF8x").

main(["grids-build", Kind, Signer, Out | Rest]) ->
    Dir = start(),
    grids_build(Kind, Signer, Out, Rest, Dir);
main(["grids-submit", Request, Signed]) ->
    _ = start(),
    grids_submit(Request, Signed);
main([KeyFile, "fees"]) ->
    {Me, Sec, Dir} = setup(KeyFile),
    fees(Me, Sec, Dir);
main([KeyFile, "round2"]) ->
    {Me, Sec, Dir} = setup(KeyFile),
    round2(Me, Sec, Dir);
main([KeyFile]) ->
    {Me, Sec, Dir} = setup(KeyFile),
    round1(Me, Sec, Dir);
main(_) ->
    io:format("usage: run-probes.escript <key-file> [round2]~n"),
    halt(1).

start() ->
    Zomp = os:getenv("ZOMP_DIR", filename:join(os:getenv("HOME"), ".zx/zomp")),
    ok = code:add_paths(latest_ebins(filename:join(Zomp, "lib/otpr"))),
    {ok, _} = application:ensure_all_started(hakuzaru),
    ok = hz:chain_nodes([?NODE]),
    filename:dirname(escript:script_name()).

setup(KeyFile) ->
    _ = start(),
    {ok, Bin} = file:read_file(KeyFile),
    {Pub, Sec} = binary_to_term(Bin),
    Me = binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)),
    {Me, Sec, filename:dirname(escript:script_name())}.

round1(Me, Sec, Dir) ->
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
                             contract => contract(ChildId), init_saw => init_saw(Me, Sec, FAACI, Fac, ChildId)}),

    %% E4: Chain.clone of that child, funded in the same call.
    {CloneTx, Clone} = call(Me, Sec, FAACI, Fac, ?X, "clone_funded", [ChildId]),
    CloneId = contract_id(Clone),
    log("E4 clone", CloneTx, #{clone => CloneId, balance => balance(CloneId),
                               contract => contract(CloneId), init_saw => init_saw(Me, Sec, FAACI, Fac, CloneId)}),

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
    ok.

%% Round 2 (design audit follow-ups and the open QPQ questions, 2026-10-06).
round2(Me, Sec, Dir) ->
    Sized = compile(Dir, "probe-sized-escrow.aes"),
    Booker = compile(Dir, "probe-booker.aes"),
    Legs = compile(Dir, "probe-handover.aes"),
    LegOnly = compile(Dir, "probe-leg.aes"),
    PayC = compile(Dir, "probe-payability.aes"),
    [_SAACI, BAACI, HAACI, LAACI, PAACI] =
        [hz_aaci:prepare(maps:get(aci, C)) || C <- [Sized, Booker, Legs, LegOnly, PayC]],
    Funds = balance(Me),
    log("runner", Me, #{balance => Funds}),
    Funds >= 5 * ?X orelse error({insufficient_balance, Me, Funds}),
    {ok, Top} = hz:top_height(),
    Deadline = integer_to_list(Top + 10000),
    Unfunded = fresh_address(),
    Panel = "[" ++ Unfunded ++ "]",
    EscArgs = [Me, ?COURIER, ?COURIER02, "[]", Panel, "1", "10", "50",
               "#00000000000000000000000000000000000000000000000000000000000000ff",
               "[(\"NLRTM\", 60)]", Deadline],

    %% E14: a realistic escrow, created by transaction (code + source on-chain) vs cloned.
    {{CreateTx, Template}, CreateCost} = cost(Me, fun() -> create(Me, Sec, Sized, ?X, EscArgs) end),
    log("E14 create sized escrow", CreateTx,
        #{contract => Template, bytecode_bytes => byte_size(maps:get(byte_code, Sized)),
          total_cost_puck => CreateCost - ?X, gas_used => gas_used(CreateTx)}),
    {BookTx, Booking} = create(Me, Sec, Booker, 0, []),
    log("booker create", BookTx, #{contract => Booking}),
    {{CloneTx, Clone}, CloneCost} =
        cost(Me, fun() -> call(Me, Sec, BAACI, Booking, ?X, "book",
                               [Template, ?COURIER, ?COURIER02, "[]", Panel, Deadline]) end),
    CloneId = contract_id(Clone),
    log("E14 clone sized escrow", CloneTx,
        #{clone => CloneId, balance => balance(CloneId), total_cost_puck => CloneCost - ?X,
          gas_used => gas_used(CloneTx), clone_vs_create => {CloneCost - ?X, CreateCost - ?X}}),

    %% E15: the clone's init event is in the booking transaction's log, under the clone's id.
    {ok, #{"call_info" := #{"log" := CloneLog}}} = hz:tx_info(CloneTx),
    log("E15 clone init events in the caller's log", CloneTx,
        #{log_addresses => [maps:get("address", L) || L <- CloneLog], clone => CloneId,
          booked_topic_matches => [hd(maps:get("topics", L)) || L <- CloneLog]
                                  =:= [topic("Booked")]}),

    %% E16: a wrapper contract can't act for its signer: callees see it as Call.caller.
    {_, LegA} = create(Me, Sec, LegOnly, 0, [Me]),
    {_, LegB} = create(Me, Sec, LegOnly, 0, [Me]),
    {_, LegC} = create(Me, Sec, LegOnly, 0, [Me]),
    {HandTx, Hand} = create(Me, Sec, Legs, 0, []),
    {DirectTx, _} = call(Me, Sec, LAACI, LegA, 0, "confirm", []),
    {WrapTx, WrapWhy} = call_revert(Me, Sec, HAACI, Hand, 0, "handover", [LegB, LegC]),
    {ViaTx, _} = call(Me, Sec, HAACI, Hand, 0, "whoami_via", [LegB]),
    {_, Seen} = call(Me, Sec, LAACI, LegB, 0, "seen", []),
    {HalfTx, HalfWhy} = call_revert(Me, Sec, HAACI, Hand, 0, "half_handover", [LegC]),
    {_, SeenC} = call(Me, Sec, LAACI, LegC, 0, "seen", []),
    log("E16 handover through one contract call", HandTx,
        #{direct_confirm_by_attestor => DirectTx,
          wrapper_confirm => {WrapTx, WrapWhy},
          callee_saw_caller_origin => {ViaTx, Seen, wrapper, Hand, signer, Me},
          rolled_back_when_second_call_fails => {HalfTx, HalfWhy, SeenC}}),

    %% E12: zero-value spends and Address.is_payable.
    {_, PayProbe} = create(Me, Sec, PayC, 0, []),
    Payable = fun(A) -> dry_value(Me, PAACI, PayProbe, "is_payable", [A]) end,
    log("E12 Address.is_payable", PayProbe,
        #{funded_account => Payable(Me), unfunded_account => {Unfunded, Payable(Unfunded)},
          payable_contract => Payable(PayProbe), non_payable_contract => Payable(Hand),
          payable_escrow_clone => Payable(CloneId)}),
    Zero1 = try_call(Me, Sec, PAACI, PayProbe, 0, "spend_zero", [?COURIER], 200000),
    Zero2 = try_call(Me, Sec, PAACI, PayProbe, 0, "spend_zero", [Unfunded], 200000),
    Zero3 = try_call(Me, Sec, PAACI, PayProbe, 0, "spend_zero", [Hand], 200000),
    log("E12 Chain.spend(_, 0)", PayProbe,
        #{to_funded_account => Zero1, to_unfunded_account => Zero2,
          to_non_payable_contract => Zero3, unfunded_now_exists => hz:acc(Unfunded)}),

    %% E17: the minimum gas price. Last, because a transaction the pool accepts but no
    %% miner takes would block the account's later nonces; the closing bump replaces it.
    {_, Probe} = create(Me, Sec, PayC, 0, []),
    Low = [{GP, post_at_gas_price(Me, Sec, PAACI, Probe, GP)}
           || GP <- [100000000, 999999999]],
    {Clear, _} = call(Me, Sec, PAACI, Probe, 0, "is_payable", [Me]),
    log("E17 gas price below 10^9", Probe, #{results => Low, nonce_cleared_by => Clear}),
    log("runner", Me, #{balance => balance(Me), round2_cost_puck => Funds - balance(Me)}),
    ok.

%% E18: what a transaction costs, and what drives it. The same read-only call with
%% different gas limits, a payout, a small and a large create, and a clone.
fees(Me, Sec, Dir) ->
    PayC = compile(Dir, "probe-payability.aes"),
    PAACI = hz_aaci:prepare(maps:get(aci, PayC)),
    Sized = compile(Dir, "probe-sized-escrow.aes"),
    {ok, Top} = hz:top_height(),
    Deadline = integer_to_list(Top + 10000),
    Panel = "[" ++ fresh_address() ++ "]",
    Step = fun(Label, F) ->
                   {{Hash, _}, Cost} = cost(Me, F),
                   {ok, #{"tx" := Tx}} = hz:tx(Hash),
                   G = gas_used(Hash),
                   log("E18 " ++ Label, Hash,
                       #{cost_puck => Cost, gas_used => G, gas_limit => maps:get("gas", Tx),
                         cost_in_gas => Cost div 1000000000,
                         not_execution => Cost div 1000000000 - G})
           end,
    {_, Probe} = create(Me, Sec, PayC, 0, []),
    Step("small call, gas limit 200k", fun() -> try_ok(Me, Sec, PAACI, Probe, 0, "is_payable", [Me], 200000) end),
    Step("small call, gas limit 5M", fun() -> try_ok(Me, Sec, PAACI, Probe, 0, "is_payable", [Me], 5000000) end),
    Step("zero spend", fun() -> try_ok(Me, Sec, PAACI, Probe, 0, "spend_zero", [?COURIER], 200000) end),
    Step("small create (100 B code)", fun() -> create(Me, Sec, PayC, 0, []) end),
    Step("sized create (4.4 KB code)",
         fun() -> create(Me, Sec, Sized, ?X, [Me, ?COURIER, ?COURIER02, "[]", Panel, "1", "10", "50",
                                              "#00000000000000000000000000000000000000000000000000000000000000ff",
                                              "[(\"NLRTM\", 60)]", Deadline]) end),
    log("runner", Me, #{balance => balance(Me)}),
    ok.

try_ok(Me, Sec, AACI, Con, Amount, Fun, Args, Gas) ->
    {Hash, {ok, V}} = try_call(Me, Sec, AACI, Con, Amount, Fun, Args, Gas),
    {Hash, V}.

%% E9: one GRIDS request (the format GajuDesk 0.9.0 reads), for the signer's next nonce.
grids_build(Kind, Signer, Out, Rest, Dir) ->
    {ok, NetworkID} = hz:network_id(),
    {Type, Payload} = grids_payload(Kind, Signer, Rest, Dir),
    Request = #{"grids" => 1, "chain" => "gajumaru", "network_id" => NetworkID,
                "type" => Type, "public_id" => Signer, "payload" => Payload},
    ok = file:write_file(Out, zj:encode(Request)),
    log("E9 request " ++ Kind, Out, #{type => Type, nonce => nonce(Signer)}).

grids_payload("book", Signer, [Booker, Template], Dir) ->
    AACI = hz_aaci:prepare(maps:get(aci, compile(Dir, "probe-booker.aes"))),
    {ok, Top} = hz:top_height(),
    Panel = "[" ++ fresh_address() ++ "]",
    {ok, Tx} = hz:contract_call(Signer, nonce(Signer), 5000000, 1000000000, ?X, Top + 20,
                                AACI, Booker, "book",
                                {sophia, [Template, ?COURIER, ?COURIER02, "[]", Panel,
                                          integer_to_list(Top + 10000)]}),
    {"tx", Tx};
grids_payload("create", Signer, [], Dir) ->
    {ok, Top} = hz:top_height(),
    {ok, Tx} = hz:contract_create_built(Signer, nonce(Signer), 5000000, 1000000000, ?X,
                                        Top + 20, compile(Dir, "probe-escrow.aes"),
                                        {sophia, [integer_to_list(?X)]}),
    {"tx", Tx};
grids_payload("message", Signer, [], _) ->
    Nonce = binary:encode_hex(crypto:strong_rand_bytes(16)),
    {"message", "GajuFreight sign-in\ndomain: localhost\nnetwork: groot.testnet\naccount: "
                ++ Signer ++ "\nnonce: " ++ binary_to_list(Nonce)}.

%% What the relay must check before submitting (ADR 0012): the wallet signed exactly the
%% transaction we built, as the expected account, for this network.
grids_submit(RequestFile, SignedFile) ->
    {ok, ReqJSON} = file:read_file(RequestFile),
    {ok, SignedJSON} = file:read_file(SignedFile),
    {ok, Req = #{"type" := Type, "public_id" := ID, "network_id" := NID}} = zj:decode(ReqJSON),
    {ok, Resp} = zj:decode(SignedJSON),
    log("E9 response", SignedFile, maps:without(["payload"], Resp)),
    {account_pubkey, PK} = gmser_api_encoder:decode(list_to_binary(ID)),
    case Type of
        "message" ->
            #{"signature" := Sig} = Resp,
            %% Verify against the challenge we issued, never the text the client echoes.
            Same = maps:get("payload", Resp) =:= maps:get("payload", Req),
            Valid = hz:verify_signature(Sig, list_to_binary(maps:get("payload", Req)),
                                        list_to_binary(ID)),
            log("E9 message signature", SignedFile, #{same_message => Same, valid => Valid}),
            (Same andalso Valid =:= {ok, true}) orelse error(refused);
        "tx" ->
            Unsigned = maps:get("payload", Req),
            Signed = maps:get("payload", Resp),
            {ok, UBin} = gmser_api_encoder:safe_decode(transaction, list_to_binary(Unsigned)),
            {ok, SBin} = gmser_api_encoder:safe_decode(transaction, list_to_binary(Signed)),
            [{signatures, [Sig]}, {transaction, Inner}] =
                gmser_chain_objects:deserialize(signed_tx, 1,
                                                [{signatures, [binary]}, {transaction, binary}],
                                                SBin),
            {ok, Hash} = eblake2:blake2b(32, Inner),
            Same = Inner =:= UBin,
            Valid = ecu_eddsa:sign_verify_detached(Sig, <<(list_to_binary(NID))/binary, Hash/binary>>, PK),
            log("E9 relay checks", SignedFile, #{inner_tx_unchanged => Same, signature_valid => Valid,
                                                 signed_flag => maps:get("signed", Resp, missing)}),
            (Same andalso Valid) orelse error(refused),
            {ok, #{"tx_hash" := TxHash}} = hz:post_tx(Signed),
            Info = wait(TxHash, 60),
            log("E9 submitted and mined", TxHash, maps:get("call_info", Info))
    end.

compile(Dir, File) ->
    {ok, Built} = so_compiler:file(filename:join(Dir, File), [{aci, json}]),
    Built.

%% What a step really cost the runner: the balance change, which includes the size-based
%% part of the fee that gas_used doesn't show. Steps run one at a time, so it's exact.
cost(Me, Step) ->
    Before = balance(Me),
    Result = Step(),
    {Result, Before - balance(Me)}.

gas_used(Hash) ->
    {ok, #{"call_info" := #{"gas_used" := G}}} = hz:tx_info(Hash),
    G.

topic(Name) ->
    binary:decode_unsigned(element(2, eblake2:blake2b(32, list_to_binary(Name)))).

%% A new account that has never received anything, so it doesn't exist on-chain.
fresh_address() ->
    {Pub, _} = crypto:generate_key(eddsa, ed25519),
    binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)).

dry_value(Me, AACI, Con, Fun, Args) ->
    case dry(Me, AACI, Con, Fun, Args) of
        {ok, #{"call_obj" := #{"return_type" := "ok", "return_value" := RV}}} -> decode(RV);
        Other                                                               -> Other
    end.

%% Posts a call below the usual gas price and reports whether the node takes it and a
%% miner includes it within a minute.
post_at_gas_price(Me, Sec, AACI, Con, GasPrice) ->
    Nonce = nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_call(Me, Nonce, 200000, GasPrice, 0, Height + 20,
                                AACI, Con, "is_payable", {sophia, [Me]}),
    {ok, NetworkID} = hz:network_id(),
    case hz:post_tx(hz:sign_tx(Tx, Sec, NetworkID)) of
        {ok, #{"tx_hash" := Hash}} ->
            case catch wait(Hash, 20) of
                #{"call_info" := _} -> {mined, Hash};
                _                   -> {accepted_not_mined, Hash}
            end;
        Error ->
            {rejected, Error}
    end.

%% zx keeps old versions side by side (hakuzaru 0.6.1 and 0.9.1); load only the newest.
latest_ebins(Lib) ->
    Version = fun(V) -> [list_to_integer(P) || P <- string:split(V, ".", all)] end,
    [filename:join([Lib, App, lists:last(lists:sort(fun(A, B) -> Version(A) =< Version(B) end,
                                                    filelib:wildcard("*", filename:join(Lib, App)))),
                    "ebin"])
     || App <- filelib:wildcard("*", Lib)].

%% What a ProbeChild's init recorded (balance, Call.value), read through the factory.
init_saw(Me, Sec, FAACI, Fac, Id) ->
    {_, {tuple, {Funded, Value}}} = call(Me, Sec, FAACI, Fac, 0, "child_saw", [Id]),
    #{balance_in_init => Funded, call_value_in_init => Value}.

%% A create that must succeed: a revert stops the run with its reason.
create(Me, Sec, Built, Amount, Args) ->
    Nonce = nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_create_built(Me, Nonce, 5000000, 1000000000, Amount, Height + 1000,
                                        Built, {sophia, Args}),
    Info = submit(Tx, Sec),
    Hash = maps:get("tx_hash", Info),
    case maps:get("call_info", Info) of
        #{"return_type" := "ok", "contract_id" := Id} -> {Hash, Id};
        #{"return_value" := RV}                       -> error({create_reverted, Hash, decode(RV)})
    end.

%% The next nonce after the account's last mined transaction, not hz:next_nonce/1, which
%% counts pending transactions: one that can never be mined (e.g. posted while unfunded)
%% would otherwise block every later one. A new transaction at that nonce replaces it.
nonce(Me) ->
    {ok, #{"nonce" := N}} = hz:acc(Me),
    N + 1.

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
    try_call(Me, Sec, AACI, Con, Amount, Fun, Args, 5000000).

try_call(Me, Sec, AACI, Con, Amount, Fun, Args, Gas) ->
    Nonce = nonce(Me),
    {ok, Height} = hz:top_height(),
    {ok, Tx} = hz:contract_call(Me, Nonce, Gas, 1000000000, Amount, Height + 1000,
                                AACI, Con, Fun, {sophia, Args}),
    Info = submit(Tx, Sec),
    #{"return_type" := Type, "return_value" := RV} = maps:get("call_info", Info),
    Result = case Type of
                 "ok"     -> {ok, decode(RV)};
                 "revert" -> {revert, decode(RV)};
                 %% A failed spend (e.g. to a non-payable contract) is an "error", not a
                 %% revert, and uses all the gas given (E6b).
                 "error"  -> {revert, {error, RV, gas_used, maps:get("gas_used", maps:get("call_info", Info))}};
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
    Nonce = nonce(Me),
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
