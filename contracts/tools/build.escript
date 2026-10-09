#!/usr/bin/env escript
%% Builds the contracts and their interface catalogue (ADR 0014, C1 #61, C2 #62).
%%
%%   escript contracts/tools/build.escript [--network NAME] [--check]
%%
%% For a network (contracts/networks/NAME.json, default "build"), it substitutes that
%% network's platform address for PLATFORM_ADDRESS, compiles each contracts/src/*.aes, and
%% writes contracts/build/NAME/: the substituted source, bytecode (cb_...), ACI and a
%% manifest of compiler and content hashes.
%%
%% It also writes the network-independent interface catalogue, the one source of
%% entrypoints, events, types and error codes for every layer:
%%   contracts/interface/<contract>.aci.json, contracts/interface/errors.json,
%%   docs/contract-interface.md
%% --check builds the catalogue in memory and fails if the committed files differ.
%%
%% The compiler comes from SOPHIA_LIBS (a directory built by build-sophia.sh, as in CI),
%% or else from the zx packages GajuDesk installs (ZOMP_DIR, default ~/.zx/zomp).
-mode(compile).

main(Args) ->
    {Network, Check} = parse(Args, {"build", false}),
    Root = filename:absname(filename:join(filename:dirname(escript:script_name()), "../..")),
    Compiler = load_compiler(),
    Config = read_json(filename:join([Root, "contracts", "networks", Network ++ ".json"])),
    Platform = case maps:get(<<"platform_address">>, Config, null) of
                   null -> fail("network ~s has no platform_address yet: deploy Platform first", [Network]);
                   Address -> binary_to_list(Address)
               end,
    Sources = lists:sort(filelib:wildcard(filename:join([Root, "contracts", "src", "*.aes"]))),
    Built = [compile(Root, Network, Platform, Source) || Source <- Sources],
    Catalogue = catalogue(Built),
    case Check of
        true ->
            check(Root, Catalogue);
        false ->
            write_build(Root, Network, Config, Compiler, Built),
            [write(filename:join(Root, Path), Content) || {Path, Content} <- Catalogue],
            io:format("built ~b contracts for ~s; catalogue written~n", [length(Built), Network])
    end.

parse([], Acc) -> Acc;
parse(["--network", Name | Rest], {_, Check}) -> parse(Rest, {Name, Check});
parse(["--check" | Rest], {Network, _}) -> parse(Rest, {Network, true});
parse(_, _) -> fail("usage: build.escript [--network NAME] [--check]", []).

fail(Format, Args) ->
    io:format(standard_error, Format ++ "~n", Args),
    halt(1).

%% ---- compiler -------------------------------------------------------------------

load_compiler() ->
    case os:getenv("SOPHIA_LIBS") of
        false ->
            Zomp = os:getenv("ZOMP_DIR", filename:join(os:getenv("HOME"), ".zx/zomp")),
            Lib = filename:join(Zomp, "lib/otpr"),
            ok = code:add_paths(newest_ebins(Lib)),
            #{source => <<"zx">>, sophia => version_of(Lib, "sophia")};
        Dir ->
            ok = code:add_paths(filelib:wildcard(filename:join([Dir, "lib", "*", "ebin"]))),
            Commit = string:trim(os:cmd("git -C " ++ filename:join([Dir, "lib", "sophia"]) ++ " rev-parse HEAD")),
            #{source => <<"sophia-mirror">>, sophia => list_to_binary(Commit)}
    end.

%% zx keeps old versions side by side; load only the newest of each package.
newest_ebins(Lib) ->
    [filename:join([Lib, App, newest(Lib, App), "ebin"]) || App <- filelib:wildcard("*", Lib)].

newest(Lib, App) ->
    Version = fun(V) -> [list_to_integer(P) || P <- string:split(V, ".", all)] end,
    lists:last(lists:sort(fun(A, B) -> Version(A) =< Version(B) end,
                          filelib:wildcard("*", filename:join(Lib, App)))).

version_of(Lib, App) -> list_to_binary(newest(Lib, App)).

%% ---- build ----------------------------------------------------------------------

compile(Root, Network, Platform, Source) ->
    Name = filename:basename(Source, ".aes"),
    {ok, Original} = file:read_file(Source),
    Substituted = binary:replace(Original, <<"PLATFORM_ADDRESS">>, list_to_binary(Platform), [global]),
    Dir = filename:join([Root, "contracts", "build", Network]),
    ok = filelib:ensure_path(Dir),
    Path = filename:join(Dir, Name ++ ".aes"),
    ok = file:write_file(Path, Substituted),
    case so_compiler:file(Path, [{aci, json}]) of
        {ok, Result} ->
            #{name => Name, source => Original, substituted => Substituted, result => Result};
        {error, Errors} ->
            [io:format(standard_error, "~s~n", [so_errors:pp(E)]) || E <- Errors],
            fail("~s: compile failed", [Name])
    end.

write_build(Root, Network, Config, Compiler, Built) ->
    Dir = filename:join([Root, "contracts", "build", Network]),
    Contracts =
        [begin
             #{name := Name, source := Source, substituted := Sub, result := Result} = C,
             Bytecode = maps:get(byte_code, Result),
             Encoded = gmser_api_encoder:encode(contract_bytearray, Bytecode),
             write(filename:join(Dir, Name ++ ".bytecode"), <<Encoded/binary, "\n">>),
             write(filename:join(Dir, Name ++ ".aci.json"), json_text(contract_aci(Result))),
             #{contract => list_to_binary(Name),
               source_sha256 => sha256(Source), substituted_sha256 => sha256(Sub),
               bytecode_sha256 => sha256(Bytecode), bytecode_bytes => byte_size(Bytecode)}
         end || C <- Built],
    Manifest = #{network => list_to_binary(Network),
                 network_id => maps:get(<<"network_id">>, Config),
                 platform_address => maps:get(<<"platform_address">>, Config),
                 compiler => Compiler, contracts => Contracts},
    write(filename:join(Dir, "manifest.json"), json_text(Manifest)).

sha256(Bin) -> list_to_binary(io_lib:format("~64.16.0b", [binary:decode_unsigned(crypto:hash(sha256, Bin))])).

%% A source may declare interfaces to other contracts too; the catalogue is about the
%% contract it defines (kind contract_main).
contract_aci(Result) ->
    [Contract] = [C || #{contract := C = #{kind := contract_main}} <- maps:get(aci, Result)],
    Contract.

%% ---- catalogue ------------------------------------------------------------------

catalogue(Built) ->
    Acis = [{Name, contract_aci(R)} || #{name := Name, result := R} <- Built],
    Errors = lists:append([errors(Name, Source) || #{name := Name, source := Source} <- Built]),
    [{filename:join(["contracts", "interface", Name ++ ".aci.json"]), json_text(Aci)} || {Name, Aci} <- Acis]
        ++ [{"contracts/interface/errors.json", json_text(Errors)},
            {"docs/contract-interface.md", markdown(Acis, Errors)}].

%% An error code is the UPPER_SNAKE string a require(...) or abort(...) carries. A call
%% may span lines (the code on a continuation line), so each is read until its
%% brackets close. Other strings (event names, statuses, the DELIVERED label) don't count.
errors(Contract, Source) ->
    Lines = string:split(Source, <<"\n">>, all),
    {_, _, Found} = lists:foldl(fun scan/2, {none, none, #{}}, Lines),
    [#{code => Code, contract => list_to_binary(Contract), raised_in => lists:usort(Fns)}
     || {Code, Fns} <- lists:sort(maps:to_list(Found))].

%% State: {current function, open require/abort text or none, codes found}.
scan(Line, {Current, Open, Acc}) ->
    Fun = case re:run(Line, "^\\s*(?:stateful\\s+|payable\\s+)*(?:entrypoint|function)\\s+([a-z_][a-zA-Z0-9_]*)",
                      [{capture, all_but_first, binary}]) of
              {match, [Name]} -> Name;
              nomatch -> Current
          end,
    Text = case {Open, re:run(Line, "(?:require|abort)\\(", [{capture, first, index}])} of
               {none, nomatch} -> none;
               {none, {match, [{At, _}]}} -> binary:part(Line, At, byte_size(Line) - At);
               {Pending, _} -> <<Pending/binary, Line/binary>>
           end,
    case Text of
        none -> {Fun, none, Acc};
        _ ->
            case balanced(Text) of
                false -> {Fun, Text, Acc};
                true -> {Fun, none, lists:foldl(fun(Code, A) -> add(Code, Fun, A) end, Acc, codes(Text))}
            end
    end.

balanced(Text) ->
    Count = fun(C) -> length(binary:matches(Text, C)) end,
    Count(<<"(">>) =< Count(<<")">>).

codes(Text) ->
    case re:run(Text, "\"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\"", [global, {capture, all_but_first, binary}]) of
        {match, Ms} -> [C || [C] <- Ms];
        nomatch -> []
    end.

add(Code, Fun, Acc) -> maps:update_with(Code, fun(L) -> [Fun | L] end, [Fun], Acc).

markdown(Acis, Errors) ->
    Header = [
        "# Contract interface\n\n",
        "| | |\n| :--- | :--- |\n",
        "| **Status** | Generated by `escript contracts/tools/build.escript` from `contracts/src`. Don't edit by hand: CI fails if it drifts |\n",
        "| **Related** | [HLD §5](hld.md#5-contract-sketch-sophia) · [ADR 0014](adr/0014-contract-toolchain.md) · ",
        "[`contracts/interface/`](../contracts/interface/) |\n\n",
        "The entrypoints, events, types and error codes of each contract, taken from the compiler's ACI and the sources. ",
        "Services, the dashboard's `chain-types` and the demo's error map are built from this catalogue ",
        "(`contracts/interface/*.json`), not from copies.\n"],
    [Header | [section(Name, Aci, Errors) || {Name, Aci} <- Acis]].

section(Name, Aci, Errors) ->
    Contract = maps:get(name, Aci),
    Fns = maps:get(functions, Aci),
    Rows = [io_lib:format("| `~ts` | ~ts | ~ts | ~ts | ~ts |\n",
                          [maps:get(name, F), args(maps:get(arguments, F)), type(maps:get(returns, F)),
                           yes(maps:get(stateful, F)), yes(maps:get(payable, F))])
            || F <- Fns],
    Events = case maps:get(event, Aci, none) of
                 #{variant := Vs} ->
                     [io_lib:format("| `~ts` | ~ts |\n", [E, fields(Ts)]) || V <- Vs, {E, Ts} <- maps:to_list(V)];
                 _ -> []
             end,
    Types = [typedef(T) || T <- maps:get(typedefs, Aci)],
    Codes = [io_lib:format("| `~ts` | ~ts |\n", [maps:get(code, E), join([["`", F, "`"] || F <- maps:get(raised_in, E)])])
             || E <- Errors, maps:get(contract, E) =:= list_to_binary(Name)],
    [io_lib:format("\n## ~ts\n\nSource: [`contracts/src/~ts.aes`](../contracts/src/~ts.aes).\n\n", [Contract, Name, Name]),
     "### Entrypoints\n\n| Entrypoint | Arguments | Returns | Stateful | Payable |\n| :--- | :--- | :--- | :-: | :-: |\n", Rows,
     "\n### Events\n\n| Event | Fields |\n| :--- | :--- |\n", Events,
     "\n### Types\n\n", Types,
     "\n### Error codes\n\n| Code | Raised in |\n| :--- | :--- |\n", Codes].

typedef(#{name := Name, typedef := #{record := Fields}}) ->
    io_lib:format("- `~ts`: record { ~ts }\n", [Name, join([[maps:get(name, F), " : ", type(maps:get(type, F))] || F <- Fields])]);
typedef(#{name := Name, typedef := #{variant := Vs}}) ->
    io_lib:format("- `~ts`: ~ts\n", [Name, join([variant(V) || V <- Vs], " \\| ")]);
typedef(#{name := Name, typedef := T}) ->
    io_lib:format("- `~ts`: ~ts\n", [Name, type(T)]).

variant(V) ->
    [{C, Ts}] = maps:to_list(V),
    case Ts of [] -> C; _ -> [C, "(", join([type(T) || T <- Ts]), ")"] end.

fields([]) -> "—";
fields(Ts) -> join([type(T) || T <- Ts]).

args([]) -> "—";
args(As) -> join([[maps:get(name, A), " : ", type(maps:get(type, A))] || A <- As]).

type(T) when is_binary(T) ->
    case binary:split(T, <<".">>) of [_Contract, Local] -> Local; [Simple] -> Simple end;
type(#{tuple := []}) -> "unit";
type(#{tuple := Ts}) -> ["(", join([type(X) || X <- Ts], " * "), ")"];
type(#{<<"list">> := [T]}) -> ["list(", type(T), ")"];
type(#{<<"option">> := [T]}) -> ["option(", type(T), ")"];
type(#{<<"map">> := [K, V]}) -> ["map(", type(K), ", ", type(V), ")"];
type(Other) -> io_lib:format("~p", [Other]).

yes(true) -> "✓";
yes(false) -> "".

join(Parts) -> join(Parts, ", ").
join(Parts, Sep) -> lists:join(Sep, Parts).

%% ---- files ----------------------------------------------------------------------

json_text(Term) -> [json:format(Term), "\n"].

read_json(Path) ->
    case file:read_file(Path) of
        {ok, Bin} -> json:decode(Bin);
        {error, Reason} -> fail("~s: ~p", [Path, Reason])
    end.

write(Path, Content) ->
    ok = filelib:ensure_dir(Path),
    ok = file:write_file(Path, unicode:characters_to_binary(Content)).

check(Root, Catalogue) ->
    Drift = [Path || {Path, Content} <- Catalogue,
                     file:read_file(filename:join(Root, Path)) =/= {ok, unicode:characters_to_binary(Content)}],
    case Drift of
        [] -> io:format("interface catalogue matches contracts/src~n");
        _ -> fail("interface catalogue out of date (run contracts/tools/build.escript): ~p", [Drift])
    end.
