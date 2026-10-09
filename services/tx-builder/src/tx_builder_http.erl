%%% @doc The tx-builder's HTTP API, an inets httpd callback module. JSON in and out:
%%%   GET  /health          service and contracts loaded
%%%   POST /calls           unsigned contract call + fee estimate
%%%   POST /creates         unsigned contract create + fee estimate
%%%   POST /hash            FATE blake2b hash of Sophia values
%%%   POST /events/decode   name and fields of logged events
-module(tx_builder_http).

-export([do/1]).

-include_lib("inets/include/httpd.hrl").

do(#mod{method = Method, request_uri = Uri, entity_body = Body}) ->
    {Status, Reply} = try route(Method, path(Uri), Body)
                      catch Class:Reason:Stack ->
                          logger:error("~p ~s: ~p:~p ~p", [Method, Uri, Class, Reason, Stack]),
                          {500, #{error => <<"internal error">>}}
                      end,
    Json = iolist_to_binary(json:encode(Reply)),
    {proceed, [{response, {response, [{code, Status}, {content_type, "application/json"},
                                      {content_length, integer_to_list(byte_size(Json))}],
                           [Json]}}]}.

path(Uri) -> hd(string:split(Uri, "?")).

route("GET", "/health", _) ->
    {200, #{status => <<"ok">>, contracts => tx_builder_contracts:names()}};
route("POST", "/calls", Body) ->
    reply(with_body(Body, fun(B) -> required(B, [contract, contract_name, function, args, caller], fun tx_builder_calls:call/1) end));
route("POST", "/creates", Body) ->
    reply(with_body(Body, fun(B) -> required(B, [contract_name, args, caller], fun tx_builder_calls:create/1) end));
route("POST", "/hash", Body) ->
    reply(with_body(Body, fun hash/1));
route("POST", "/events/decode", Body) ->
    reply(with_body(Body, fun decode_events/1));
route(_, _, _) ->
    {404, #{error => <<"not found">>}}.

with_body(Body, Handle) ->
    try json:decode(list_to_binary(Body)) of
        Decoded when is_map(Decoded) -> Handle(Decoded);
        _ -> {error, bad_request}
    catch
        error:_ -> {error, bad_json}
    end.

%% A request missing required fields, or with a field of the wrong type, is the caller's
%% error (400), named in the reply.
required(Body, Keys, Build) ->
    maybe
        {ok, Req} ?= request(Body),
        [] ?= [K || K <- Keys, not maps:is_key(K, Req)],
        Build(Req)
    else
        Missing when is_list(Missing) -> {error, {missing, Missing}};
        Error -> Error
    end.

hash(Body) ->
    maybe
        {ok, [Parts]} ?= fields(Body, [{parts, <<"parts">>, list}]),
        {ok, Ps} ?= all(fun part/1, Parts),
        tx_builder_fate:hash(Ps)
    end.

decode_events(Body) ->
    maybe
        {ok, [Name, Log]} ?= fields(Body, [{contract_name, <<"contract_name">>, binary},
                                           {log, <<"log">>, list}]),
        tx_builder_fate:decode_events(Name, Log)
    end.

%% The named fields' values, in order, or which are missing or of the wrong type.
fields(Body, Specs) ->
    case [Key || {Key, Name, _} <- Specs, not maps:is_key(Name, Body)] of
        [] ->
            case [Key || {Key, Name, Type} <- Specs, not is_type(Type, maps:get(Name, Body))] of
                [] -> {ok, [maps:get(Name, Body) || {_, Name, _} <- Specs]};
                Bad -> {error, {bad_type, Bad}}
            end;
        Missing ->
            {error, {missing, Missing}}
    end.

is_type(binary, V) -> is_binary(V);
is_type(list, V) -> is_list(V);
is_type(map, V) -> is_map(V).

all(Fun, Items) ->
    lists:foldr(fun(Item, {ok, Acc}) -> case Fun(Item) of {ok, V} -> {ok, [V | Acc]}; E -> E end;
                   (_, Error) -> Error
                end, {ok, []}, Items).

reply({ok, Result}) -> {200, Result};
reply({error, Reason}) -> {400, #{error => iolist_to_binary(io_lib:format("~0p", [Reason]))}}.

%% Only the known fields become the request map (no atoms are made from input).
request(Body) ->
    Fields = [{<<"contract">>, contract}, {<<"contract_name">>, contract_name},
              {<<"function">>, function}, {<<"args">>, args}, {<<"caller">>, caller},
              {<<"amount">>, amount}, {<<"nonce">>, nonce}, {<<"ttl">>, ttl}, {<<"gas">>, gas},
              {<<"dry_run">>, dry_run}],
    Present = [{Key, value(Key, V)} || {Name, Key} <- Fields, (V = maps:get(Name, Body, undefined)) =/= undefined],
    case [Key || {Key, error} <- Present] of
        [] -> {ok, maps:from_list([{Key, V} || {Key, {ok, V}} <- Present])};
        Bad -> {error, {bad_type, Bad}}
    end.

value(Key, V) when Key =:= function; Key =:= caller; Key =:= contract ->
    if is_binary(V) -> {ok, binary_to_list(V)}; true -> error end;
value(contract_name, V) when is_binary(V) -> {ok, V};
value(args, Vs) when is_list(Vs) ->
    case lists:all(fun is_binary/1, Vs) of
        true -> {ok, [binary_to_list(V) || V <- Vs]};
        false -> error
    end;
value(Key, V) when is_integer(V), V >= 0, Key =/= dry_run, Key =/= args, Key =/= contract_name -> {ok, V};
value(dry_run, V) when is_boolean(V) -> {ok, V};
value(_, _) -> error.

part(P) when is_map(P) ->
    Specs = [{contract_name, <<"contract_name">>, binary}, {function, <<"function">>, binary},
             {argument, <<"argument">>, binary}, {value, <<"value">>, binary}],
    maybe
        {ok, [Name, Fun, Arg, Value]} ?= fields(P, Specs),
        {ok, #{contract_name => Name, function => binary_to_list(Fun),
               argument => binary_to_list(Arg), value => binary_to_list(Value)}}
    end;
part(_) ->
    {error, {bad_type, [parts]}}.
