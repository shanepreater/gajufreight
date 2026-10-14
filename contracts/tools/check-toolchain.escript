#!/usr/bin/env escript
%% Checks that a Hakuzaru build makes exactly the transactions the zx package GajuDesk installs
%% does (ADR 0014, #146): from a fixed seed it derives a key, builds three contract calls offline
%% (a variant, a list of variants and a hash, a record with an option and a tuple), signs them,
%% and compares a fingerprint of the lot with the one the zx packages give. No node is needed.
%%
%% Usage: escript contracts/tools/check-toolchain.escript <lib-dir>   # a build-toolchain.sh build
%%        escript contracts/tools/check-toolchain.escript zx          # print the zx fingerprint
-mode(compile).

%% sha256 of the zx 0.9.1 packages' output (hakuzaru 0.9.1, ec_utils 1.0.0, sophia 9.0.0).
-define(ZX_FINGERPRINT, "5f5b6ea79c22451de997395864ba7d90cfa2f98c1568856d7ca0f5b038df380e").

main([Libs]) ->
    ok = code:add_paths(ebins(Libs)),
    Root = filename:dirname(filename:dirname(filename:dirname(filename:absname(escript:script_name())))),
    Fingerprint = fingerprint(Root),
    case Libs of
        "zx" ->
            io:format("~s~n", [Fingerprint]);
        _ when Fingerprint =:= ?ZX_FINGERPRINT ->
            io:format("Hakuzaru build matches the zx packages: ~s~n", [Fingerprint]);
        _ ->
            io:format(standard_error, "Hakuzaru build differs from the zx packages: ~s, expected ~s~n",
                      [Fingerprint, ?ZX_FINGERPRINT]),
            halt(1)
    end;
main(_) ->
    io:format(standard_error, "usage: check-toolchain.escript <lib-dir> | zx~n", []),
    halt(2).

fingerprint(Root) ->
    #{public := Pub, secret := Sec} = ecu_eddsa:sign_seed_keypair(<<1:256>>),
    Me = binary_to_list(gmser_api_encoder:encode(account_pubkey, Pub)),
    Con = binary_to_list(gmser_api_encoder:encode(contract_pubkey, <<2:256>>)),
    Hash = "#" ++ lists:duplicate(64, $a),
    Calls = [{"platform.aes", "propose", ["SetSetting(\"fee_bps\", 5)"]},
             {"platform.aes", "verify", [Me, Hash, "9", "[Arbiter, Carrier]"]},
             {"quote-request.aes", "quote",
              ["{price = 10000, schedule = [(\"Yantian\", 20)], deadline = 11, attestors = [" ++ Me ++
                   "], replace = None}", "9"]}],
    Signed = [sign(Root, File, Fun, Args, Me, Con, Sec) || {File, Fun, Args} <- Calls],
    Parts = [Pub | [list_to_binary(S) || S <- Signed]],
    binary_to_list(binary:encode_hex(crypto:hash(sha256, Parts), lowercase)).

sign(Root, File, Fun, Args, Me, Con, Sec) ->
    {ok, AACI} = hz:prepare_contract(filename:join([Root, "contracts", "src", File])),
    {ok, Tx} = hz:contract_call(Me, 7, 100000, 1000000000, 0, 500000, AACI, Con, Fun, {sophia, Args}),
    binary_to_list(hz:sign_tx(Tx, Sec, "groot_testnet")).

%% A build-toolchain.sh lib dir, or the newest of each zx package.
ebins("zx") ->
    Lib = filename:join(os:getenv("ZOMP_DIR", filename:join(os:getenv("HOME"), ".zx/zomp")), "lib/otpr"),
    Version = fun(V) -> [list_to_integer(P) || P <- string:split(V, ".", all)] end,
    [filename:join([Lib, App, lists:last(lists:sort(fun(A, B) -> Version(A) =< Version(B) end,
                                                    filelib:wildcard("*", filename:join(Lib, App)))),
                    "ebin"])
     || App <- filelib:wildcard("*", Lib)];
ebins(Libs) ->
    filelib:wildcard(filename:join([Libs, "lib", "*", "ebin"])).
