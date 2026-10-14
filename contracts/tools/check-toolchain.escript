#!/usr/bin/env escript
%% Checks that a Hakuzaru build makes exactly the transactions the zx package GajuDesk installs
%% does (ADR 0014, #146): from a fixed seed it derives a key, builds three calls to a frozen
%% fixture contract offline (a variant, a list of variants and a hash, a record with an option
%% and a tuple), signs them, and compares a fingerprint of the lot with the one the zx packages
%% give. No node is needed, and changes to the real contracts don't affect it.
%%
%% Usage: escript contracts/tools/check-toolchain.escript <lib-dir>   # a build-toolchain.sh build
%%        escript contracts/tools/check-toolchain.escript zx          # print the zx fingerprint
-mode(compile).

%% sha256 of the zx packages' output. Regenerate with `zx` (the exact versions below must be
%% installed) only when the fixture or the pins change on purpose.
-define(ZX_FINGERPRINT, "359a4cd7ac75f9f7f00be3bf351d14121a55b240bf24708fbf6888002c5384de").

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
            io:format(standard_error, "Hakuzaru build differs from the zx packages: ~s, expected ~s~n"
                      "If check-toolchain.aes or a pin changed on purpose, regenerate with `zx`.~n",
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
    Calls = [{"propose", ["SetSetting(\"fee_bps\", 5)"]},
             {"verify", [Me, Hash, "9", "[Arbiter, Carrier]"]},
             {"quote",
              ["{price = 10000, schedule = [(\"Yantian\", 20)], deadline = 11, attestors = [" ++ Me ++
                   "], replace = None}", "9"]}],
    {ok, AACI} = hz:prepare_contract(filename:join([Root, "contracts", "tools", "check-toolchain.aes"])),
    Signed = [sign(AACI, Fun, Args, Me, Con, Sec) || {Fun, Args} <- Calls],
    Parts = [Pub | [list_to_binary(S) || S <- Signed]],
    binary_to_list(binary:encode_hex(crypto:hash(sha256, Parts), lowercase)).

sign(AACI, Fun, Args, Me, Con, Sec) ->
    {ok, Tx} = hz:contract_call(Me, 7, 100000, 1000000000, 0, 500000, AACI, Con, Fun, {sophia, Args}),
    binary_to_list(hz:sign_tx(Tx, Sec, "groot_testnet")).

%% A build-toolchain.sh lib dir, or exactly the zx versions build-toolchain.sh pins.
ebins("zx") ->
    Lib = filename:join(os:getenv("ZOMP_DIR", filename:join(os:getenv("HOME"), ".zx/zomp")), "lib/otpr"),
    Pinned = [{"hakuzaru", "0.9.1"}, {"ec_utils", "1.0.0"}, {"sophia", "9.0.0"}, {"gmbytecode", "3.4.1"},
              {"gmserialization", "0.1.3"}, {"zj", "1.1.0"}, {"base58", "0.1.1"}, {"eblake2", "1.0.1"}],
    [installed(filename:join([Lib, App, Vsn, "ebin"]), App, Vsn) || {App, Vsn} <- Pinned];
ebins(Libs) ->
    filelib:wildcard(filename:join([Libs, "lib", "*", "ebin"])).

installed(Dir, App, Vsn) ->
    case filelib:is_dir(Dir) of
        true -> Dir;
        false -> io:format(standard_error, "zx ~s ~s is not installed~n", [App, Vsn]), halt(2)
    end.
