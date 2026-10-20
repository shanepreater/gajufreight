#!/usr/bin/env escript
%% Replays the demo suite's traces against the compiled contracts (#70, contracts/test/README.md).
%%
%%   escript contracts/test/replay.escript plan   [options]   which traces fit, and what they cost
%%   escript contracts/test/replay.escript encode [options]   build and sign every step offline
%%
%% Options:
%%   --traces DIR      traces recorded by `npm run test:traces` (default contracts/build/traces)
%%   --libs DIR|zx     a build-toolchain.sh build, or the zx packages (default zx)
%%   --max-blocks N    only traces that wait at most N key blocks in all (plan: 0; encode: any)
%%   --limit N         at most N traces, sampled by --seed (default all that fit)
%%   --seed N          the sample's seed, printed so a run can be repeated (default 1)
%%   --max-value PUCK  only traces whose accounts send at most this much (plan: 10^18; encode: any)
-mode(compile).

-define(GAS, 5000000).
-define(GAS_PRICE, 1000000000).
%% What each transaction may cost: a call's fixed charge is about 182,600 gas (spike E18), and
%% a create's grows with its size. Funding allows this per step; unused gas isn't charged.
-define(STEP_ALLOWANCE, 500000000000000).
%% Arguments that are block heights: rebased by the trace's offset (contracts/test/README.md).
-define(HEIGHTS, ["deadline", "valid_until", "deliver_by", "expires"]).

main([Mode | Args]) when Mode =:= "plan"; Mode =:= "encode" ->
    %% A live run (and its plan) fits a budget; encoding offline has none, so checks every trace.
    Budget = case Mode of
                 "plan" -> #{max_blocks => 0, max_value => 1000000000000000000};
                 "encode" -> #{max_blocks => infinity, max_value => infinity}
             end,
    Opts = options(Args, Budget#{traces => default_traces(), libs => "zx", limit => all, seed => 1}),
    ok = code:add_paths(ebins(maps:get(libs, Opts))),
    Chosen = select(load(maps:get(traces, Opts)), Opts),
    case Mode of
        "plan" -> plan(Chosen, Opts);
        "encode" -> encode_all(Chosen)
    end;
main(_) ->
    io:format(standard_error, "usage: replay.escript plan|encode [options] (see the header)~n", []),
    halt(2).

%% ── Choosing traces ──────────────────────────────────────────────────────────────────────

load(Dir) ->
    Files = lists:sort(filelib:wildcard(filename:join(Dir, "*.jsonl"))),
    Files =:= [] andalso fail("no traces in ~s: run `npm run test:traces --prefix scripts/demo`", [Dir]),
    [T#{"id" => io_lib:format("~s:~b", [filename:basename(F, ".jsonl"), I])}
     || F <- Files,
        {I, T} <- lists:zip(lists:seq(1, length(lines(F))), [decode(L) || L <- lines(F)]),
        maps:get("unreplayable", T) =:= undefined].

lines(File) ->
    {ok, Bin} = file:read_file(File),
    [L || L <- binary:split(Bin, <<"\n">>, [global]), L =/= <<>>].

decode(Line) ->
    {ok, T} = zj:decode(Line),
    T.

select(Traces, #{max_blocks := Max, max_value := MaxValue, limit := Limit, seed := Seed}) ->
    Fit = [T || T <- Traces, within(blocks(T), Max), within(sent(T), MaxValue)],
    rand:seed(exsss, {Seed, Seed, Seed}),
    Shuffled = [T || {_, T} <- lists:sort([{rand:uniform(), T} || T <- Fit])],
    case Limit of
        all -> Shuffled;
        N -> lists:sublist(Shuffled, N)
    end.

within(_, infinity) -> true;
within(N, Max) -> N =< Max.

blocks(T) -> lists:sum([maps:get("keyblocks", S) || S <- steps(T), op(S) =:= "advance"]).

sent(T) -> lists:sum([int(maps:get("value", S)) || S <- transactions(T)]).

steps(T) -> maps:get("steps", T).
op(S) -> maps:get("op", S).
transactions(T) -> [S || S <- steps(T), lists:member(op(S), ["deploy", "call"])].

%% What each account a trace uses must hold: the value it sends, plus gas for each step.
funding(T) ->
    lists:foldl(fun(S, Acc) ->
                        Caller = maps:get("caller", S),
                        Need = int(maps:get("value", S)) + ?STEP_ALLOWANCE,
                        maps:update_with(Caller, fun(V) -> V + Need end, Need, Acc)
                end, #{}, transactions(T)).

plan(Chosen, Opts) ->
    Total = lists:sum([lists:sum(maps:values(funding(T))) || T <- Chosen]),
    Txs = lists:sum([length(transactions(T)) || T <- Chosen]),
    io:format("seed ~b: ~b traces, ~b transactions, waiting at most ~p key blocks each~n",
              [maps:get(seed, Opts), length(Chosen), Txs, maps:get(max_blocks, Opts)]),
    io:format("funding needed: ~s Gaju (value sent plus gas allowance)~n", [gaju(Total)]),
    [io:format("  ~s  ~b transactions~n", [maps:get("id", T), length(transactions(T))]) || T <- Chosen],
    ok.

%% ── Offline encoding ─────────────────────────────────────────────────────────────────────

%% Builds and signs every step of every chosen trace with made-up nonces and addresses, as the
%% runner will: proves each argument converts to the contract's types before money is spent.
encode_all(Chosen) ->
    self_check(),
    Results = [{maps:get("id", T), encode_trace(T)} || T <- Chosen],
    Failed = [{Id, Why} || {Id, {error, Why}} <- Results],
    [io:format(standard_error, "~s: ~s~n", [Id, Why]) || {Id, Why} <- Failed],
    io:format("encoded ~b of ~b traces offline~n", [length(Results) - length(Failed), length(Results)]),
    Failed =:= [] orelse halt(1).

encode_trace(T) ->
    Run = #{addresses => #{}, offset => 500000 - 1,
            seed => maps:get("id", T)},
    Numbered = lists:zip(lists:seq(1, length(steps(T))), steps(T)),
    try
        lists:foldl(fun encode_step/2, Run, Numbered),
        ok
    catch
        throw:{step, I, Why} -> {error, io_lib:format("step ~b: ~s", [I, Why])}
    end.

%% Any failure is reported against its step, by its place in the trace.
encode_step({I, S}, Run) ->
    try
        case op(S) of
            "account" -> Run;
            "advance" -> Run;
            _ -> build(S, Run)
        end
    catch
        throw:{fail, Why} -> throw({step, I, Why});
        error:Reason -> throw({step, I, io_lib:format("~p", [Reason])})
    end.

build(S = #{"op" := "deploy", "contract" := Kind}, Run) ->
    Compiled = compiled(Kind, maps:get("platform", S, undefined), Run),
    Args = args(Kind, "init", maps:get("args", S), Run),
    {Caller, Secret} = account(maps:get("caller", S), Run),
    case hz:contract_create_built(Caller, 1, ?GAS, ?GAS_PRICE, int(maps:get("value", S)), 1000,
                                  Compiled, {fate, Args}) of
        {ok, Tx} -> _ = hz:sign_tx(Tx, Secret, "groot.testnet"),
                    bind(maps:get("as", S, undefined), contract, Run);
        Error -> throw({fail, io_lib:format("deploy ~s: ~p", [Kind, Error])})
    end;
build(S = #{"op" := Op, "contract" := Label, "function" := Fun}, Run) ->
    Kind = kind(Label),
    Args = args(Kind, Fun, maps:get("args", S), Run),
    {AACI, Con} = {aaci(Kind), contract(Label, Run)},
    %% A view has no caller in a trace: on a node it is a dry run of this call from any account.
    {Caller, Secret} = account(maps:get("caller", S, "viewer"), Run),
    case hz:contract_call(Caller, 1, ?GAS, ?GAS_PRICE, int(maps:get("value", S, #{"$int" => "0"})), 1000,
                          AACI, Con, Fun, {fate, Args}) of
        {ok, _} when Op =:= "view" -> Run;
        {ok, Tx} ->
            _ = hz:sign_tx(Tx, Secret, "groot.testnet"),
            bind_result(S, Run);
        Error -> throw({fail, io_lib:format("~s.~s: ~p", [Kind, Fun, Error])})
    end.

%% The runner's FATE must match Hakuzaru's Sophia-literal path, which the spike proved on testnet:
%% the same call built both ways, for a hash, an option, a record, a tuple and variants.
self_check() ->
    Run = #{addresses => #{"Q#1" => contract_address(<<2:256>>)}, offset => 0, seed => "self-check"},
    {Me, _} = account("me", Run),
    Q = contract("Q#1", Run),
    Hash = lists:duplicate(64, $a),
    Hex = "#" ++ binary_to_list(binary:encode_hex(opaque(Hash), lowercase)),
    Cases = [{"Platform", "book", [#{"$addr" => "Q#1"}, Hash, #{"$addr" => "me"}],
              [Q, Hex, "Some(" ++ Me ++ ")"]},
             {"Platform", "verify", [#{"$addr" => "me"}, Hash, 9, [#{"$variant" => ["Arbiter"]}]],
              [Me, Hex, "9", "[Arbiter]"]},
             {"QuoteRequest", "quote", [#{"price" => #{"$int" => "5"}, "schedule" => [["A", 20]], "deadline" => 7,
                                          "attestors" => [#{"$addr" => "me"}], "replace" => undefined}, 9],
              ["{price = 5, schedule = [(\"A\", 20)], deadline = 7, attestors = [" ++ Me ++ "], replace = None}", "9"]}],
    [begin
         Fate = args(Kind, Fun, Json, Run),
         {ok, Ours} = hz:contract_call(Me, 1, ?GAS, ?GAS_PRICE, 0, 1000, aaci(Kind), Q, Fun, {fate, Fate}),
         {ok, Theirs} = hz:contract_call(Me, 1, ?GAS, ?GAS_PRICE, 0, 1000, aaci(Kind), Q, Fun, {sophia, Sophia}),
         Ours =:= Theirs orelse fail("self-check: ~s.~s call data differs from Hakuzaru's Sophia path", [Kind, Fun])
     end || {Kind, Fun, Json, Sophia} <- Cases],
    ok.

contract_address(Pub) -> binary_to_list(gmser_api_encoder:encode(contract_pubkey, Pub)).

%% A call that returns a contract it created (Platform.new_quote, book) names it from then on.
bind_result(#{"result" := #{"$addr" := Label}}, Run) -> bind(Label, contract, Run);
bind_result(_, Run) -> Run.

%% ── Contracts, accounts and addresses ────────────────────────────────────────────────────

root() ->
    filename:dirname(filename:dirname(filename:dirname(filename:absname(escript:script_name())))).

default_traces() -> filename:join([root(), "contracts", "build", "traces"]).

source(Kind) ->
    File = #{"Platform" => "platform.aes", "QuoteRequest" => "quote-request.aes",
             "ShipmentEscrow" => "shipment-escrow.aes"},
    {ok, Bin} = file:read_file(filename:join([root(), "contracts", "src", maps:get(Kind, File)])),
    Bin.

compile(Source) ->
    {ok, Compiled} = so_compiler:from_string(binary_to_list(Source), [{aci, json}]),
    Compiled.

%% Compiling and reading interfaces are the slow parts, so each happens once per run.
cached(Key, Make) ->
    case persistent_term:get(Key, undefined) of
        undefined ->
            Value = Make(),
            persistent_term:put(Key, Value),
            Value;
        Value -> Value
    end.

%% Platform and QuoteRequest as they are; each escrow template with its platform's address. The
%% escrow's ABI is the same whatever the address, so a placeholder build gives its AACI.
compiled("ShipmentEscrow", undefined, _) ->
    escrow_for(gmser_api_encoder:encode(account_pubkey, <<0:256>>));
compiled("ShipmentEscrow", Platform, Run) ->
    escrow_for(list_to_binary(account_form(contract(Platform, Run))));
compiled(Kind, _, _) ->
    cached({compiled, Kind}, fun() -> compile(source(Kind)) end).

escrow_for(Address) ->
    cached({escrow, Address}, fun() ->
        compile(binary:replace(source("ShipmentEscrow"), <<"PLATFORM_ADDRESS">>, Address, [global]))
    end).

aaci(Kind) ->
    cached({aaci, Kind}, fun() -> hz_aaci:prepare(maps:get(aci, compiled(Kind, undefined, #{}))) end).

kind(Label) -> hd(string:split(Label, "#")).

%% Each account's key comes from the run's seed and its label, so a run can be repeated.
account(Label, #{seed := Seed}) ->
    {ok, Key} = eblake2:blake2b(32, iolist_to_binary([Seed, "/", Label])),
    #{public := Pub, secret := Sec} = ecu_eddsa:sign_seed_keypair(Key),
    {binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)), Sec}.

%% A contract's address once it exists; offline, a made-up one per label.
bind(undefined, _, Run) -> Run;
bind(Label, contract, Run = #{addresses := A}) ->
    {ok, Fake} = eblake2:blake2b(32, list_to_binary(Label)),
    Run#{addresses := A#{Label => binary_to_list(gmser_api_encoder:encode(contract_pubkey, Fake))}}.

contract(Label, #{addresses := A}) ->
    case A of
        #{Label := Address} -> Address;
        _ -> throw({fail, io_lib:format("no contract ~s yet", [Label])})
    end.

%% The same public key in account form, as a contract's address in an `address` position.
account_form(ContractAddress) ->
    {contract_pubkey, Pub} = gmser_api_encoder:decode(list_to_binary(ContractAddress)),
    binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)).

address(#{"$addr" := Label}, Run) ->
    case lists:member($#, Label) of
        true -> account_form(contract(Label, Run));
        false -> element(1, account(Label, Run))
    end.

%% ── Values: trace JSON to Hakuzaru's Erlang form, by the contract's types ────────────────

%% A call's arguments as FATE, by the contract's types. They are passed to Hakuzaru as {fate, …}:
%% its {erlang, …} path encodes hash and bytes values as FATE strings (Hakuzaru 0.9.1), which
%% the contract would reject, so the bytes are wrapped here (see fate/5).
args(Kind, Fun, Values, Run) ->
    Names = [maps:get("name", A) || A <- maps:get("arguments", function(Kind, Fun))],
    [fate(Kind, Fun, Name, V, Run) || {Name, V} <- lists:zip(Names, Values)].

%% The published interface catalogue: what the app and indexer use too. CI's build --check
%% fails if it drifts from the source.
aci_json(Kind) ->
    cached({aci, Kind}, fun() ->
        File = #{"Platform" => "platform", "QuoteRequest" => "quote-request", "ShipmentEscrow" => "shipment-escrow"},
        {ok, Bin} = file:read_file(filename:join([root(), "contracts", "interface", maps:get(Kind, File) ++ ".aci.json"])),
        {ok, ACI} = zj:decode(Bin),
        ACI
    end).

function(Kind, Fun) ->
    [F] = [F || F <- maps:get("functions", aci_json(Kind)), maps:get("name", F) =:= Fun],
    F.

typedef(Kind, Name) ->
    [Owner, Short] = case string:split(Name, ".") of [O, N] -> [O, N]; [N] -> [Kind, N] end,
    [T] = [maps:get("typedef", D) || D <- maps:get("typedefs", aci_json(Owner)), maps:get("name", D) =:= Short],
    {Owner, T}.

is_contract_type(Name) -> lists:member(Name, ["Platform", "QuoteRequest", "ShipmentEscrow"]).

value(_, "int", V, Name, Run) -> height(Name, int(V), Run);
value(_, "bool", V, _, _) -> V;
value(_, "string", V, _, _) -> V;
value(_, "address", V, _, Run) -> address(V, Run);
value(_, "hash", V, _, Run) -> bytes(V, Run);
value(_, #{"bytes" := 32}, V, _, Run) -> bytes(V, Run);
value(_, Type, V, _, Run) when is_list(Type), hd(Type) >= $A, hd(Type) =< $Z ->
    case is_contract_type(Type) of
        true -> contract(maps:get("$addr", V), Run);
        false -> named(Type, V, Run)
    end;
value(K, #{"option" := [_]}, undefined, _, _) -> _ = K, {"None"};
value(K, #{"option" := [T]}, V, Name, Run) -> {"Some", value(K, T, V, Name, Run)};
value(K, #{"list" := [T]}, V, Name, Run) -> [value(K, T, X, Name, Run) || X <- V];
value(K, #{"tuple" := Ts}, V, Name, Run) ->
    list_to_tuple([value(K, T, X, Name, Run) || {T, X} <- lists:zip(Ts, V)]);
value(_, Type, V, _, _) -> throw({fail, io_lib:format("no encoding for ~p: ~p", [Type, V])}).

named(Type, V, Run) ->
    {Owner, Def} = typedef(hd(string:split(Type, ".")), Type),
    case Def of
        #{"record" := Fields} ->
            maps:from_list([{N, value(Owner, T, maps:get(N, V), N, Run)}
                            || #{"name" := N, "type" := T} <- Fields]);
        #{"variant" := Constructors} ->
            #{"$variant" := [C | Xs]} = V,
            [ArgTypes] = [Ts || Con <- Constructors, {Name, Ts} <- maps:to_list(Con), Name =:= C],
            list_to_tuple([C | [value(Owner, T, X, "", Run) || {T, X} <- lists:zip(ArgTypes, Xs)]])
    end.

int(#{"$int" := S}) -> list_to_integer(S);
int(N) when is_integer(N) -> N.

%% A block height moves by the trace's offset, so it means the same distance from "now".
height(Name, V, #{offset := Offset}) ->
    case lists:member(Name, ?HEIGHTS) of
        true -> V + Offset;
        false -> V
    end.

%% A hash: rebuilt from what it was made of if the contracts compute it, else opaque bytes.
bytes(#{"$hash" := #{"kind" := Kind, "of" := Of}}, Run) -> hash(Kind, Of, Run);
bytes(V, _) when is_list(V) -> opaque(V).

opaque(String) ->
    {ok, Bytes} = eblake2:blake2b(32, unicode:characters_to_binary(String)),
    Bytes.

%% Crypto.blake2b of a value is blake2b of its FATE serialisation (spike E8). Each kind's parts
%% are converted with the type the contract gives them, through Hakuzaru's typed conversion, so
%% field order, variant tags and string encoding are the contract's, not written out by hand.
-define(HASH_PARTS, #{"job" => [{"Platform", "book", "manifest"}, {"Platform", "book", "consignee"}],
                      "terms" => [{"QuoteRequest", "quote", "t"}],
                      "commitment" => [{"Platform", "matches", A} || A <- ["name", "country", "number", "salt"]]}).

hash(Kind, Of, Run) ->
    Parts = [fate(C, F, A, part(Kind, A, Of), Run) || {C, F, A} <- maps:get(Kind, ?HASH_PARTS)],
    Value = case Parts of
                [One] -> One;
                Many -> {tuple, list_to_tuple(Many)}
            end,
    {ok, Hash} = eblake2:blake2b(32, gmb_fate_encoding:serialize(Value)),
    Hash.

part("terms", _, Of) -> Of;  % the whole quote_terms record
part(_, Arg, Of) -> maps:get(Arg, Of, undefined).

%% One argument's value as FATE, by the type the contract declares for it.
fate(Contract, Fun, Arg, Json, Run) ->
    [Type] = [T || #{"name" := N, "type" := T} <- maps:get("arguments", function(Contract, Fun)), N =:= Arg],
    {ok, {Annotated, _}} = hz_aaci:get_function_signature(aaci(Contract), Fun),
    {Arg, Typed} = lists:keyfind(Arg, 1, Annotated),
    case hz_aaci:erlang_to_fate(Typed, value(Contract, Type, Json, Arg, Run)) of
        {ok, Fate} -> wrap_bytes(Typed, Fate);
        Error -> throw({fail, io_lib:format("~s.~s ~s: ~p", [Contract, Fun, Arg, Error])})
    end.

%% FATE holds bytes (a hash) as {bytes, Binary}; Hakuzaru 0.9.1's conversion leaves a bare
%% binary, which is a FATE string. Walks the annotated type and wraps them.
wrap_bytes({_, _, {bytes, _}}, B) when is_binary(B) -> {bytes, B};
wrap_bytes({_, _, {list, [T]}}, L) when is_list(L) -> [wrap_bytes(T, X) || X <- L];
wrap_bytes({_, _, {tuple, Ts}}, {tuple, V}) -> {tuple, wrap_all(Ts, V)};
wrap_bytes({_, _, {record, Fs}}, {tuple, V}) -> {tuple, wrap_all([T || {_, T} <- Fs], V)};
wrap_bytes({_, _, {variant, Cs}}, {variant, Arities, Tag, V}) ->
    {_, Ts} = lists:nth(Tag + 1, Cs),
    {variant, Arities, Tag, wrap_all(Ts, V)};
wrap_bytes(_, V) -> V.

wrap_all(Types, Tuple) -> list_to_tuple(lists:zipwith(fun wrap_bytes/2, Types, tuple_to_list(Tuple))).

%% ── Plumbing ─────────────────────────────────────────────────────────────────────────────

options([], Opts) -> Opts;
options(["--traces", D | R], O) -> options(R, O#{traces := D});
options(["--libs", L | R], O) -> options(R, O#{libs := L});
options(["--max-blocks", N | R], O) -> options(R, O#{max_blocks := list_to_integer(N)});
options(["--limit", N | R], O) -> options(R, O#{limit := list_to_integer(N)});
options(["--seed", N | R], O) -> options(R, O#{seed := list_to_integer(N)});
options(["--max-value", N | R], O) -> options(R, O#{max_value := list_to_integer(N)});
options([Other | _], _) -> fail("unknown option ~s", [Other]).

ebins("zx") ->
    Lib = filename:join(os:getenv("ZOMP_DIR", filename:join(os:getenv("HOME"), ".zx/zomp")), "lib/otpr"),
    Pinned = [{"hakuzaru", "0.9.1"}, {"ec_utils", "1.0.0"}, {"sophia", "9.0.0"}, {"gmbytecode", "3.4.1"},
              {"gmserialization", "0.1.3"}, {"zj", "1.1.0"}, {"base58", "0.1.1"}, {"eblake2", "1.0.1"}],
    [filename:join([Lib, App, Vsn, "ebin"]) || {App, Vsn} <- Pinned];
ebins(Libs) ->
    filelib:wildcard(filename:join([Libs, "lib", "*", "ebin"])).

gaju(Puck) -> io_lib:format("~.4f", [Puck / 1.0e18]).

fail(Format, Args) ->
    io:format(standard_error, Format ++ "~n", Args),
    halt(2).
