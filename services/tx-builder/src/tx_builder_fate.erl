%%% @doc FATE hashes and event decoding, so services never re-implement FATE encoding.
%%%
%%% A hash is blake2b-256 of a value's FATE serialisation, exactly what a contract's
%%% Crypto.blake2b computes (spike E8). Each value is a Sophia literal whose type is an
%%% argument of a known function; several values hash as a tuple, which is how the job
%%% hash blake2b((manifest, consignee)) is formed.
-module(tx_builder_fate).

-export([hash/1, decode_events/2, topic/1]).

%% Parts: [#{contract_name, function, argument, value}].
hash(Parts) ->
    maybe
        {ok, Fates} ?= fates(Parts, []),
        Value = case Fates of [One] -> One; _ -> {tuple, list_to_tuple(Fates)} end,
        {ok, Hash} ?= eblake2:blake2b(32, gmb_fate_encoding:serialize(Value)),
        {ok, #{hash => <<"#", (binary:encode_hex(Hash, lowercase))/binary>>}}
    end.

fates([], Acc) ->
    {ok, lists:reverse(Acc)};
fates([#{contract_name := Name, function := Fun, argument := Arg, value := Value} | Rest], Acc) ->
    maybe
        {ok, #{aaci := AACI}} ?= tx_builder_contracts:get(Name),
        {ok, {ArgDefs, _Returns}} ?= hz_aaci:get_function_signature(AACI, Fun),
        {ok, Def} ?= case lists:keyfind(Arg, 1, ArgDefs) of
                         {_, D} -> {ok, D};
                         false -> {error, {unknown_argument, Fun, Arg}}
                     end,
        {ok, Fate} ?= hz_sophia:parse_literal(Def, Value),
        fates(Rest, [Fate | Acc])
    end.

%% Log entries as the node returns them: #{<<"address">>, <<"topics">>, <<"data">>}.
decode_events(Name, Log) ->
    maybe
        {ok, #{events := Events}} ?= tx_builder_contracts:get(Name),
        ByTopic = maps:from_list([{topic(E), {E, Types}} || {E, Types} <- Events]),
        {ok, [decode(Entry, ByTopic) || Entry <- Log]}
    end.

topic(Name) ->
    {ok, Digest} = eblake2:blake2b(32, Name),
    binary:decode_unsigned(Digest).

decode(#{<<"address">> := Address, <<"topics">> := [First | Indexed], <<"data">> := Data}, ByTopic) ->
    case maps:find(First, ByTopic) of
        {ok, {Event, Types}} ->
            #{event => Event, address => Address, fields => fields(Types, Indexed, payload(Data))};
        error ->
            #{event => null, address => Address, fields => []}
    end.

%% Indexed fields are the word-sized ones, in order; a string field is the payload.
fields([<<"string">> | Types], Indexed, Payload) -> [Payload | fields(Types, Indexed, Payload)];
fields([Type | Types], [Word | Indexed], Payload) -> [word(Type, Word) | fields(Types, Indexed, Payload)];
fields([], _, _) -> [].

word(<<"address">>, Word) -> gmser_api_encoder:encode(account_pubkey, <<Word:256>>);
word(<<"hash">>, Word) -> <<"#", (binary:encode_hex(<<Word:256>>, lowercase))/binary>>;
word(<<"bool">>, Word) -> Word =/= 0;
word(_, Word) -> Word.

payload(Data) ->
    case gmser_api_encoder:safe_decode(contract_bytearray, Data) of
        {ok, Bytes} -> Bytes;
        _ -> Data
    end.
