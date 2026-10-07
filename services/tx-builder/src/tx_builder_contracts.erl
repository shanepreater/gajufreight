%%% @doc The contracts the service builds transactions for: the network's built sources
%%% (contracts/build/NETWORK/*.aes, written by contracts/tools/build.escript), compiled
%%% once at start-up and kept in persistent_term.
-module(tx_builder_contracts).

-export([load/1, get/1, names/0]).

-define(KEY, {?MODULE, contracts}).

%% Compile every .aes in Dir; an undefined Dir loads none (health still answers).
load(undefined) ->
    persistent_term:put(?KEY, #{}),
    ok;
load(Dir) ->
    Sources = filelib:wildcard(filename:join(Dir, "*.aes")),
    Contracts = maps:from_list([compile(Source) || Source <- Sources]),
    persistent_term:put(?KEY, Contracts),
    ok.

get(Name) ->
    case maps:find(Name, persistent_term:get(?KEY, #{})) of
        {ok, Contract} -> {ok, Contract};
        error -> {error, {unknown_contract, Name}}
    end.

names() ->
    lists:sort(maps:keys(persistent_term:get(?KEY, #{}))).

compile(Source) ->
    Name = list_to_binary(filename:basename(Source, ".aes")),
    {ok, Built} = so_compiler:file(Source, [{aci, json}]),
    Aci = maps:get(aci, Built),
    [Main] = [C || #{contract := C = #{kind := contract_main}} <- Aci],
    Events = case maps:get(event, Main, none) of
                 #{variant := Variants} -> [hd(maps:to_list(V)) || V <- Variants];
                 _ -> []
             end,
    {Name, #{built => Built, aaci => hz_aaci:prepare(Aci), events => Events}}.
