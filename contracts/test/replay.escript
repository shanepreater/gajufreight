#!/usr/bin/env escript
%% Replays the demo suite's traces against the compiled contracts (#70, contracts/test/README.md).
%%
%%   escript contracts/test/replay.escript plan   [options]   which traces fit, and what they cost
%%   escript contracts/test/replay.escript encode [options]   build and sign every step offline
%%   escript contracts/test/replay.escript run    [options]   replay on a node and compare every step
%%
%% Options:
%%   --traces DIR      traces recorded by `npm run test:traces` (default contracts/build/traces)
%%   --libs DIR|zx     a build-toolchain.sh build, or the zx packages (default zx)
%%   --max-blocks N    only traces that wait at most N key blocks in all (plan: 0; encode: any)
%%   --limit N         at most N traces, sampled by --seed (default all that fit)
%%   --seed N          the sample's seed, printed so a run can be repeated (default 1)
%%   --only FILE:N     just that trace (e.g. shipment-escrow.test.js:245), whatever the budget
%%   --max-value PUCK  only traces whose accounts send at most this much (plan, run: 10^18; encode: any)
%% run only:
%%   --node HOST:PORT  the node (default tsuriai.jp:4013, Groot testnet; see docs/qpq-q-and-a.md)
%%   --funder FILE     the throwaway funder key (default gaju-private/testnet-funder.json)
%%   --concurrency N   traces replayed at once (default 8)
-mode(compile).

-define(GAS, 5000000).
-define(GAS_PRICE, 1000000000).
%% What each transaction may cost: a call's fixed charge is about 182,600 gas (spike E18), and
%% a create's grows with its size. Funding allows this per step; unused gas isn't charged.
-define(STEP_ALLOWANCE, 500000000000000).
%% A live run's gas limit. The node checks the caller can pay the whole limit, so every account
%% holds that much on top of its allowance (funding/1); unused gas isn't charged (E18).
-define(LIVE_GAS, 1000000).
%% Failures that happen before a transaction exists: the runner can't send these (README, Errors).
-define(UNSENDABLE, ["INSUFFICIENT_BALANCE", "UNKNOWN_ACCOUNT", "BAD_VALUE"]).
%% Testnet keeps producing blocks while a trace runs, so a deadline or window can pass sooner
%% than in the demo (README). Once the chain is past a step's mapped height, an expiry instead of
%% success, or success instead of a wait, is timing, not a mismatch.
-define(EXPIRING, ["BAD_DEADLINE", "LATE_DEADLINE", "BAD_EXPIRY", "CONFIRM_EXPIRED",
                   "DEPOSIT_EXPIRED", "OFFER_EXPIRED", "PROPOSAL_EXPIRED"]).
%% Funding: a public node holds about this many pending transactions per sender, so many
%% accounts are funded through sub-funders in parallel (fan_out/3).
-define(PENDING, 4).
-define(FANOUT, 16).
-define(SPEND_COST, 250000 * ?GAS_PRICE).  % a spend's 20,000 gas plus its fixed charge, with room
-define(WAITING, ["NOT_EXPIRED", "ARBITRATION_OPEN", "CHALLENGE_OPEN", "DEPOSIT_WINDOW_OPEN"]).
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
main(["run" | Args]) ->
    Opts = options(Args, #{max_blocks => 0, max_value => 1000000000000000000,
                           traces => default_traces(), libs => "zx", limit => all, seed => 1,
                           node => "tsuriai.jp:4013", concurrency => 8,
                           funder => filename:join([root(), "gaju-private", "testnet-funder.json"])}),
    ok = code:add_paths(ebins(maps:get(libs, Opts))),
    Chosen = select(load(maps:get(traces, Opts)), Opts),
    live(Chosen, Opts);
main(_) ->
    io:format(standard_error, "usage: replay.escript plan|encode|run [options] (see the header)~n", []),
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

select(Traces, #{only := Id}) ->
    case [T || T <- Traces, lists:flatten(maps:get("id", T)) =:= Id] of
        [] -> fail("no replayable trace ~s", [Id]);
        Found -> Found
    end;
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

%% What each account a trace uses must hold: the value it sends, plus gas for each step, plus
%% one live gas limit, which the node checks a caller can cover before it accepts a transaction.
funding(T) ->
    lists:foldl(fun(S, Acc) ->
                        Caller = maps:get("caller", S),
                        Need = int(maps:get("value", S)) + ?STEP_ALLOWANCE,
                        maps:update_with(Caller, fun(V) -> V + Need end, Need + ?LIVE_GAS * ?GAS_PRICE, Acc)
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

%% ── Live replay ──────────────────────────────────────────────────────────────────────────

%% Funds every account the chosen traces use, replays the traces a few at a time, and compares
%% every step's outcome, result, events and balance changes with the demo's (README).
live(Chosen, Opts) ->
    {ok, _} = application:ensure_all_started(hakuzaru),
    [Host, Port] = string:split(maps:get(node, Opts), ":", trailing),
    ok = hz:chain_nodes([{Host, list_to_integer(Port)}]),
    ok = hz:timeout(30000),  % public testnet nodes can be slow to answer
    {ok, NetworkID} = hz:network_id(),
    self_check(),
    io:format("seed ~b: replaying ~b traces on ~s (~s)~n",
              [maps:get(seed, Opts), length(Chosen), maps:get(node, Opts), NetworkID]),
    fund(Chosen, funder(maps:get(funder, Opts)), NetworkID),
    Results = pool(Chosen, maps:get(concurrency, Opts), NetworkID),
    report(Results).

funder(File) ->
    {ok, Bin} = file:read_file(File),
    {ok, #{"seed_hex" := Hex}} = zj:decode(Bin),
    #{public := Pub, secret := Sec} = ecu_eddsa:sign_seed_keypair(binary:decode_hex(list_to_binary(Hex))),
    {binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)), Sec}.

%% Tops every account up to what its trace needs. Keys come from each trace's id, so a later run
%% reuses what an earlier one left and needs only the difference.
fund(Chosen, {Funder, Secret}, NetworkID) ->
    Needs = lists:usort([{element(1, account(Label, #{seed => maps:get("id", T)})), Need}
                         || T <- Chosen, {Label, Need} <- maps:to_list(funding(T))]),
    %% Each balance is read once: spends still pending from an earlier run can land meanwhile.
    %% Thousands of reads, so 16 at a time; a public node stalls on some for its full timeout.
    io:format("reading ~b balances~n", [length(Needs)]),
    Balances = pmap(fun({Address, _}) -> balance(Address) end, Needs, 16),
    TopUps = [{Address, Need - B} || {{Address, Need}, B} <- lists:zip(Needs, Balances), Need > B],
    Total = lists:sum([A || {_, A} <- TopUps]),
    Have = balance(Funder),
    io:format("funding ~b accounts with ~s Gaju; the funder ~s holds ~s~n",
              [length(TopUps), gaju(Total), Funder, gaju(Have)]),
    %% Leave room for the spends themselves, made once by the funder or a sub-funder and once more
    %% for each sub-funder's share.
    Have >= Total + (length(TopUps) + ?FANOUT) * 2 * ?SPEND_COST
        orelse fail("the funder needs more Gaju: fund ~s from the faucet", [Funder]),
    fan_out(TopUps, {Funder, Secret}, NetworkID).

%% A public node holds only about 4 pending transactions per sender, so one funder manages a
%% few spends a minute. For many accounts the funder first funds 16 sub-funders, each with its
%% share, and they fund their accounts in parallel. Sub-funder keys are fixed, so what one
%% keeps is used by the next run.

fan_out(TopUps, Funder, NetworkID) when length(TopUps) =< 4 * ?FANOUT ->
    spend_all(TopUps, Funder, NetworkID);
fan_out(TopUps, Funder, NetworkID) ->
    Shares = deal(TopUps, ?FANOUT),
    Subs = [account("sub-funder/" ++ integer_to_list(I), #{seed => "replay"}) || I <- lists:seq(1, ?FANOUT)],
    Needs = [{Sub, lists:sum([A || {_, A} <- Share]) + length(Share) * ?SPEND_COST}
             || {{Sub, _}, Share} <- lists:zip(Subs, Shares)],
    spend_all([{Sub, Short} || {Sub, Need} <- Needs, (Short = Need - balance(Sub)) > 0], Funder, NetworkID),
    Parent = self(),
    Pids = [spawn_link(fun() -> spend_all(Share, Sub, NetworkID), Parent ! {funded, self()} end)
            || {Sub, Share} <- lists:zip(Subs, Shares)],
    [receive {funded, Pid} -> io:format("  sub-funder ~b of ~b done~n", [I, ?FANOUT]) end
     || {I, Pid} <- lists:zip(lists:seq(1, length(Pids)), Pids)],
    ok.

%% Applies F to every item, at most N at once, keeping the order.
pmap(F, Items, N) ->
    Chunks = deal(lists:zip(lists:seq(1, length(Items)), Items), N),
    Parent = self(),
    Pids = [spawn_link(fun() -> Parent ! {pmap, self(), [{I, F(X)} || {I, X} <- Chunk]} end) || Chunk <- Chunks],
    Results = lists:append([receive {pmap, Pid, R} -> R end || Pid <- Pids]),
    [R || {_, R} <- lists:sort(Results)].

%% Round-robin, so each share is about the same size.
deal(Items, N) ->
    Indexed = lists:zip(lists:seq(0, length(Items) - 1), Items),
    [[X || {I, X} <- Indexed, I rem N =:= K] || K <- lists:seq(0, N - 1)].

%% Spends from one account, a few at a time, waiting for each few to be mined. Nonces are
%% counted here: the account's nonce can lag the microblocks that already hold its spends.
spend_all(TopUps, {From, Secret}, NetworkID) ->
    {ok, #{"nonce" := Last}} = ask(fun() -> hz:acc(From) end),
    spend_batches(TopUps, Last + 1, From, Secret, NetworkID).

spend_batches([], _, _, _, _) -> ok;
spend_batches(TopUps, Nonce, Funder, Secret, NetworkID) ->
    {Batch, Rest} = lists:split(min(?PENDING, length(TopUps)), TopUps),
    {ok, Height} = ask(fun hz:top_height/0),
    Hashes = [case posted(fun() -> hz:spend(Funder, Secret, Address, Amount, ?GAS_PRICE, 20000,
                                             Height + 100, Nonce + I, <<>>, NetworkID) end) of
                  {ok, Hash} -> Hash;
                  {rejected, Why} -> fail("funding ~s with ~b at nonce ~b was rejected: ~p",
                                          [Address, Amount, Nonce + I, Why])
              end || {I, {Address, Amount}} <- lists:zip(lists:seq(0, length(Batch) - 1), Batch)],
    [mined(Hash) || Hash <- Hashes],
    spend_batches(Rest, Nonce + length(Batch), Funder, Secret, NetworkID).

%% Posts a transaction. The node sometimes rejects a valid one as "Invalid tx" for a few seconds
%% after the sender's last transactions were mined, so a rejection is retried before it counts.
posted(Post) -> posted(Post, 6).

posted(Post, Tries) ->
    case Post() of
        {ok, #{"tx_hash" := Hash}} -> {ok, Hash};
        _ when Tries > 1 -> timer:sleep(10000), posted(Post, Tries - 1);
        Rejected -> {rejected, Rejected}
    end.

%% A node read, retried a few times when the node times out or errors; "not found" is an answer.
ask(Read) -> ask(Read, 5).

ask(Read, Tries) ->
    case Read() of
        {ok, _} = Answer -> Answer;
        {error, "Account not found"} = Answer -> Answer;
        _ when Tries > 1 -> timer:sleep(5000), ask(Read, Tries - 1);
        Failed -> Failed
    end.

balance(Address) -> balance(Address, 5).

%% A read that times out is retried a few times before the run gives up.
balance(Address, Tries) ->
    case hz:acc(Address) of
        {ok, #{"balance" := B}} -> B;
        {error, "Account not found"} -> 0;
        {error, _} when Tries > 1 -> timer:sleep(5000), balance(Address, Tries - 1);
        {error, Reason} -> fail("balance of ~s: ~p", [Address, Reason])
    end.

%% Waits until a transaction is in a microblock: a few seconds when the miner is up.
mined(Hash) -> mined(Hash, 180).

mined(Hash, 0) -> throw({fail, io_lib:format("~s not mined after 6 minutes", [Hash])});
mined(Hash, N) ->
    case hz:tx(Hash) of
        {ok, #{"block_height" := H}} when H > 0 -> ok;
        _ -> timer:sleep(2000), mined(Hash, N - 1)
    end.

%% A few traces at a time: each uses only its own accounts, so they don't share nonces.
pool(Traces, N, NetworkID) ->
    Parent = self(),
    Queue = spawn_link(fun() -> queue(Traces) end),
    [spawn_link(fun() -> worker(Parent, Queue, NetworkID) end) || _ <- lists:seq(1, N)],
    collect(length(Traces), 0, []).

queue(Traces) ->
    receive
        {next, From} ->
            case Traces of
                [T | Rest] -> From ! {trace, T}, queue(Rest);
                [] -> From ! done, queue([])
            end
    end.

worker(Parent, Queue, NetworkID) ->
    Queue ! {next, self()},
    receive
        {trace, T} -> Parent ! {result, run_trace(T, NetworkID)}, worker(Parent, Queue, NetworkID);
        done -> ok
    end.

collect(0, _, Acc) -> lists:reverse(Acc);
collect(Left, Done, Acc) ->
    receive
        {result, R = #{id := Id}} ->
            case R of
                #{outcome := ok} -> ok;
                #{outcome := {timing, Why}} -> io:format("  timing ~s: ~s~n", [Id, Why]);
                #{outcome := {mismatch, Why}} -> io:format("  MISMATCH ~s: ~s~n", [Id, Why])
            end,
            (Done + 1) rem 25 =:= 0 andalso io:format("  ~b traces replayed~n", [Done + 1]),
            collect(Left - 1, Done + 1, [R | Acc])
    after 3600000 ->
        fail("no trace finished in an hour", [])
    end.

run_trace(T, NetworkID) ->
    Id = maps:get("id", T),
    {ok, Top} = ask(fun hz:top_height/0),
    Run = #{addresses => #{}, offset => Top - 1, seed => Id, network => NetworkID,
            gas => [], skipped => 0},
    Numbered = lists:zip(lists:seq(1, length(steps(T))), steps(T)),
    put(addresses, #{}),
    try lists:foldl(fun live_step/2, Run, Numbered) of
        #{gas := Gas, skipped := Skipped} -> #{id => Id, outcome => ok, gas => Gas, skipped => Skipped}
    catch
        throw:{timing, I, Why} ->
            #{id => Id, outcome => {timing, io_lib:format("step ~b: ~s", [I, Why])}, gas => [], skipped => 0};
        throw:{step, I, Why} ->
            #{id => Id, outcome => {mismatch, io_lib:format("step ~b: ~s; contracts ~p", [I, Why, get(addresses)])},
              gas => [], skipped => 0}
    end.

live_step({I, S}, Run) ->
    try
        case op(S) of
            "account" -> Run;
            "advance" -> advance(maps:get("keyblocks", S)), Run;
            "view" -> live_view(S, Run);
            _ -> live_tx(S, Run)
        end
    catch
        throw:{fail, Why} -> throw({step, I, Why});
        throw:{timing, Why} -> throw({timing, I, Why});
        error:Reason:Stack -> throw({step, I, io_lib:format("~p at ~p", [Reason, hd(Stack)])})
    end.

%% Waits for that many key blocks from now, so a deadline the trace waits out has passed.
advance(N) ->
    {ok, From} = ask(fun hz:top_height/0),
    wait_height(From + N).

wait_height(Target) ->
    case ask(fun hz:top_height/0) of
        {ok, H} when H >= Target -> ok;
        _ -> timer:sleep(10000), wait_height(Target)
    end.

live_tx(S, Run) ->
    case lists:member(maps:get("error", S, none), ?UNSENDABLE) of
        true -> Run#{skipped := maps:get(skipped, Run) + 1};
        false -> send(S, Run)
    end.

send(S, Run) ->
    CallerLabel = maps:get("caller", S),
    {Caller, Secret} = account(CallerLabel, Run),
    Watch = lists:usort([CallerLabel | maps:keys(maps:get("balances", S, #{}))]),
    Before = balances(Watch, Run),
    Signed = hz:sign_tx(unsigned(S, Caller, Run), Secret, maps:get(network, Run)),
    Hash = case posted(fun() -> hz:post_tx(Signed) end) of
               {ok, H} -> H;
               {rejected, Why} -> throw({fail, io_lib:format("rejected when posted: ~p", [Why])})
           end,
    mined(Hash),
    {ok, #{"call_info" := CI0}} = ask(fun() -> hz:tx_info(Hash) end),
    CI = CI0#{"tx_hash" => Hash},
    Run1 = outcome(S, CI, Run),
    events(S, CI, Run1),
    balance_changes(S, CallerLabel, Before, balances(Watch, Run1), Run1),
    record_gas(S, CI, Run1).

unsigned(S = #{"op" := "deploy", "contract" := Kind}, Caller, Run) ->
    Compiled = compiled(Kind, maps:get("platform", S, undefined), Run),
    Args = args(Kind, "init", maps:get("args", S), Run),
    {Nonce, TTL} = nonce_ttl(Caller),
    %% Hakuzaru 0.9.1 bundles a create's source by moving the whole VM into a temporary
    %% directory and deleting it, so concurrent creates would pull the working directory out
    %% from under each other. One at a time.
    {ok, Tx} = global:trans({hakuzaru_bundle, self()}, fun() ->
        hz:contract_create_built(Caller, Nonce, ?LIVE_GAS, ?GAS_PRICE, int(maps:get("value", S)),
                                 TTL, Compiled, {fate, Args})
    end),
    Tx;
unsigned(S = #{"contract" := Label, "function" := Fun}, Caller, Run) ->
    Kind = kind(Label),
    Args = args(Kind, Fun, maps:get("args", S), Run),
    {Nonce, TTL} = nonce_ttl(Caller),
    {ok, Tx} = hz:contract_call(Caller, Nonce, ?LIVE_GAS, ?GAS_PRICE, int(maps:get("value", S)), TTL,
                                aaci(Kind), contract(Label, Run), Fun, {fate, Args}),
    Tx.

%% The next nonce after the last mined one (as the tx-builder does), and a short TTL.
nonce_ttl(Caller) ->
    Nonce = case ask(fun() -> hz:acc(Caller) end) of
                {ok, #{"nonce" := N}} -> N + 1;
                {error, "Account not found"} -> 1
            end,
    {ok, Height} = ask(fun hz:top_height/0),
    {Nonce, Height + 100}.

%% The call's outcome against the trace's: the same error code, or success with the same result.
%% A contract a call creates gets its label here, from the address the chain returned.
outcome(S, #{"return_type" := Type, "return_value" := RV} = CI, Run) ->
    case {maps:find("error", S), Type} of
        {{ok, E}, "ok"} ->
            Why = io_lib:format("expected ~s, but it succeeded", [E]),
            timing(lists:member(E, ?WAITING), S, Run, Why);
        {{ok, E}, _} ->
            Reason = reason(RV),
            matches_error(E, Reason)
                orelse timing(lists:member(Reason, ?EXPIRING), S, Run,
                              io_lib:format("expected ~s, got ~s: ~s", [E, Type, Reason])),
            Run;
        {error, "ok"} when map_get("op", S) =:= "deploy" ->
            bind_address(maps:get("as", S, undefined), maps:get("contract_id", CI), Run);
        {error, "ok"} ->
            Run1 = case maps:get("result", S, undefined) of
                       #{"$addr" := Label} -> bind_created(Label, fate_value(RV), Run);
                       _ -> Run
                   end,
            result(S, fate_value(RV), Run1),
            Run1;
        {error, _} ->
            timing(lists:member(reason(RV), ?EXPIRING), S, Run,
                   io_lib:format("expected success, got ~s: ~s (~s, gas used ~p)",
                                 [Type, reason(RV), maps:get("tx_hash", CI, "dry run"), maps:get("gas_used", CI)]))
    end.

%% A mismatch, or timing when the code is about time and the chain is past the step's height.
timing(true, #{"height" := Model}, #{offset := Offset}, Why) ->
    {ok, Top} = ask(fun hz:top_height/0),
    case Top > Model + Offset of
        true -> throw({timing, Why});
        false -> throw({fail, Why})
    end;
timing(_, _, _, Why) ->
    throw({fail, Why}).

%% A revert carries the contract's message; a VM error (e.g. value to a non-payable entrypoint)
%% carries the node's.
matches_error(E, Reason) ->
    Reason =:= E orelse
        (E =:= "NOT_PAYABLE" andalso string:find(string:lowercase(Reason), "payable") =/= nomatch).

reason(RV) ->
    {ok, Bin} = gmser_api_encoder:safe_decode(contract_bytearray, list_to_binary(RV)),
    try gmb_fate_encoding:deserialize(Bin) of
        Text when is_binary(Text) -> binary_to_list(Text);
        Other -> io_lib:format("~p", [Other])
    catch
        _:_ -> binary_to_list(Bin)
    end.

fate_value(RV) ->
    {ok, Bin} = gmser_api_encoder:safe_decode(contract_bytearray, list_to_binary(RV)),
    gmb_fate_encoding:deserialize(Bin).

bind_address(undefined, _, Run) -> Run;
%% Also kept in the process dictionary, so a mismatch can report the trace's contracts.
bind_address(Label, Address, Run = #{addresses := A}) ->
    put(addresses, (get(addresses))#{Label => Address}),
    Run#{addresses := A#{Label => Address}}.

bind_created(Label, {contract, Pub}, Run = #{addresses := A}) when not is_map_key(Label, A) ->
    bind_address(Label, contract_address(Pub), Run);
bind_created(_, _, Run) -> Run.

%% The result as FATE, converted from the trace by the function's return type.
result(S = #{"contract" := Label, "function" := Fun}, Actual, Run) ->
    case maps:get("result", S, undefined) of
        #{"$untyped" := _} -> ok;
        Json ->
            Kind = kind(Label),
            Expected = returned(Kind, Fun, Json, Run),
            Expected =:= Actual
                orelse throw({fail, io_lib:format("~s.~s returned ~p, expected ~p", [Kind, Fun, Actual, Expected])})
    end.

returned(Kind, Fun, Json, Run) ->
    Type = maps:get("returns", function(Kind, Fun)),
    {ok, {_, Typed}} = hz_aaci:get_function_signature(aaci(Kind), Fun),
    case hz_aaci:erlang_to_fate(Typed, value(Kind, Type, Json, "", Run)) of
        {ok, Fate} -> wrap_bytes(Typed, Fate);
        Error -> throw({fail, io_lib:format("~s.~s result: ~p", [Kind, Fun, Error])})
    end.

%% A view is a dry run from an account the node is told holds 1 Gaju, so it needn't exist.
live_view(S = #{"contract" := Label, "function" := Fun}, Run) ->
    Kind = kind(Label),
    {Viewer, _} = account("viewer", Run),
    {ok, Tx} = hz:contract_call(Viewer, 1, ?LIVE_GAS, ?GAS_PRICE, 0, 0, aaci(Kind), contract(Label, Run),
                                Fun, {fate, args(Kind, Fun, maps:get("args", S), Run)}),
    {ok, #{"hash" := Top}} = ask(fun hz:top_block/0),
    Request = #{top => iolist_to_binary(Top), txs => [#{tx => iolist_to_binary(Tx)}],
                accounts => [#{pub_key => list_to_binary(Viewer), amount => 1000000000000000000}]},
    case hz:dry_run_map(Request) of
        {ok, #{"results" := [#{"call_obj" := CI}]}} -> outcome(S, CI, Run);
        Other -> throw({fail, io_lib:format("dry run failed: ~p", [Other])})
    end.

%% Every watched balance must change as the trace says. Gas is the one cost the demo doesn't
%% have, and it's paid only by the caller, so the caller's change in value is the opposite of
%% everyone else's (nothing else is created or destroyed); what's left is the gas, which must be
%% positive and within the limit.
balances(Labels, Run) -> maps:from_list([{L, label_balance(L, Run)} || L <- Labels]).

label_balance(Label, Run) ->
    case lists:member($#, Label) of
        true ->
            case maps:find(Label, maps:get(addresses, Run)) of
                {ok, Contract} -> balance(account_form(Contract));
                error -> 0
            end;
        false -> balance(element(1, account(Label, Run)))
    end.

balance_changes(S, Caller, Before, After, _Run) ->
    Expected = maps:get("balances", S, #{}),
    Change = fun(L) -> maps:get(L, After) - maps:get(L, Before) end,
    Others = [L || L <- maps:keys(After), L =/= Caller],
    [Change(L) =:= int(maps:get(L, Expected, 0))
         orelse throw({fail, io_lib:format("~s's balance changed by ~b, expected ~b",
                                           [L, Change(L), int(maps:get(L, Expected, 0))])})
     || L <- Others],
    Value = -lists:sum([Change(L) || L <- Others]),
    Value =:= int(maps:get(Caller, Expected, 0))
        orelse throw({fail, io_lib:format("~s (the caller) moved ~b in value, expected ~b",
                                          [Caller, Value, int(maps:get(Caller, Expected, 0))])}),
    Gas = Value - Change(Caller),
    (Gas > 0 andalso Gas =< 2 * ?LIVE_GAS * ?GAS_PRICE)
        orelse throw({fail, io_lib:format("~s paid ~b in gas, outside (0, ~b]", [Caller, Gas, 2 * ?LIVE_GAS * ?GAS_PRICE])}),
    ok.

%% Events in the order they were emitted, except that a run of ArbiterPaid events comes in
%% address order on the chain (README), so each run is compared as a set. The node lists a
%% call's log newest first, so it is reversed here.
events(S, #{"log" := Log}, Run) ->
    Expected = maps:get("events", S, []),
    length(Log) =:= length(Expected)
        orelse throw({fail, io_lib:format("~b events logged, expected ~b: ~p", [length(Log), length(Expected), Log])}),
    Actual = [raw_event(L) || L <- lists:reverse(Log)],
    Wanted = [expected_event(E, Run) || E <- Expected],
    Offset = maps:get(offset, Run),
    same_events(sort_runs(Wanted), sort_runs(Actual), Offset)
        orelse throw({fail, io_lib:format("events ~p, expected ~p", [Actual, Wanted])}).

raw_event(#{"address" := Address, "topics" := [Topic | Words], "data" := Data}) ->
    {ok, Payload} = gmser_api_encoder:safe_decode(contract_bytearray, list_to_binary(Data)),
    {list_to_binary(Address), Topic, [{word, W} || W <- Words], Payload}.

%% The same shape from the trace: the topic is the name's hash, word-sized fields are indexed,
%% and a string field is the payload.
expected_event(#{"contract" := Label, "event" := [Name | Fields]}, Run) ->
    Kind = kind(Label),
    Types = event_types(Kind, Name),
    {ok, Digest} = eblake2:blake2b(32, list_to_binary(Name)),
    Payloads = [unicode:characters_to_binary(V) || {"string", V} <- lists:zip(Types, Fields)],
    Words = [{Type, word(Kind, Type, V, Run)} || {Type, V} <- lists:zip(Types, Fields), Type =/= "string"],
    {list_to_binary(contract(Label, Run)), binary:decode_unsigned(Digest), Words,
     case Payloads of [P] -> P; [] -> <<>> end}.

event_types(Kind, Name) ->
    #{"variant" := Constructors} = maps:get("event", aci_json(Kind)),
    [Types] = [Ts || C <- Constructors, {N, Ts} <- maps:to_list(C), N =:= Name],
    Types.

word(Kind, Type, V, Run) ->
    case value(Kind, Type, V, "", Run) of
        true -> 1;
        false -> 0;
        N when is_integer(N) -> N;
        Bytes when is_binary(Bytes) -> binary:decode_unsigned(Bytes);
        Address when is_list(Address) ->
            {_, Pub} = gmser_api_encoder:decode(list_to_binary(Address)),
            binary:decode_unsigned(Pub)
    end.

%% An int field may be a height, which the run moved by its offset; events don't name fields.
same_events(Wanted, Actual, Offset) ->
    length(Wanted) =:= length(Actual) andalso
        lists:all(fun({{A, T, Ws, P}, {A, T, Vs, P}}) when length(Ws) =:= length(Vs) ->
                          lists:all(fun({{"int", W}, {word, V}}) -> V =:= W orelse V =:= W + Offset;
                                       ({{_, W}, {word, V}}) -> V =:= W
                                    end, lists:zip(Ws, Vs));
                     (_) -> false
                  end, lists:zip(Wanted, Actual)).

sort_runs(Events) ->
    {ok, Digest} = eblake2:blake2b(32, <<"ArbiterPaid">>),
    Paid = binary:decode_unsigned(Digest),
    Runs = chunk(fun({_, T, _, _}) -> T =:= Paid end, Events),
    lists:append([case IsPaid of true -> lists:sort(fun by_words/2, Run); false -> Run end
                  || {IsPaid, Run} <- Runs]).

by_words({_, _, A, _}, {_, _, B, _}) -> [W || {_, W} <- A] =< [W || {_, W} <- B].

chunk(_, []) -> [];
chunk(Pred, [E | Es]) ->
    Key = Pred(E),
    {Same, Rest} = lists:splitwith(fun(X) -> Pred(X) =:= Key end, Es),
    [{Key, [E | Same]} | chunk(Pred, Rest)].

%% Gas for creates and the calls issue #63 asks to record (book, new_quote).
record_gas(S, #{"gas_used" := Gas}, Run = #{gas := Acc}) ->
    Name = case S of
               #{"op" := "deploy", "contract" := K} -> K ++ ".init";
               #{"contract" := L, "function" := F} -> kind(L) ++ "." ++ F
           end,
    Run#{gas := [{Name, Gas} | Acc]}.

report(Results) ->
    Failed = [R || R = #{outcome := {mismatch, _}} <- Results],
    Gas = lists:append([G || #{gas := G} <- Results]),
    Names = lists:usort([N || {N, _} <- Gas]),
    io:format("~nexecution gas (excluding each transaction's fixed charge, spike E18):~n", []),
    [begin
         Used = lists:sort([G || {M, G} <- Gas, M =:= N]),
         io:format("  ~-36s n=~-5b min ~-8b median ~-8b max ~b~n",
                   [N, length(Used), hd(Used), lists:nth((length(Used) + 1) div 2, Used), lists:last(Used)])
     end || N <- Names],
    Skipped = lists:sum([K || #{skipped := K} <- Results]),
    Timing = [R || R = #{outcome := {timing, _}} <- Results],
    io:format("~n~b of ~b traces matched, ~b timing-sensitive (need a local chain), ~b mismatched;"
              " ~b steps not sendable on a chain (README, Errors)~n",
              [length(Results) - length(Failed) - length(Timing), length(Results), length(Timing),
               length(Failed), Skipped]),
    [io:format("  timing ~s: ~s~n", [Id, Why]) || #{id := Id, outcome := {timing, Why}} <- Timing],
    [io:format("  MISMATCH ~s: ~s~n", [Id, Why]) || #{id := Id, outcome := {mismatch, Why}} <- Failed],
    Failed =:= [] orelse halt(1).

%% ── Contracts, accounts and addresses ────────────────────────────────────────────────────

%% Resolved once, while the working directory is still the caller's (see unsigned/3).
root() ->
    cached(root, fun() ->
        filename:dirname(filename:dirname(filename:dirname(filename:absname(escript:script_name()))))
    end).

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
value(_, #{"tuple" := []}, _, _, _) -> {};
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
options(["--only", Id | R], O) -> options(R, O#{only => Id});
options(["--node", N | R], O) -> options(R, O#{node := N});
options(["--funder", F | R], O) -> options(R, O#{funder := F});
options(["--concurrency", N | R], O) -> options(R, O#{concurrency := list_to_integer(N)});
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
