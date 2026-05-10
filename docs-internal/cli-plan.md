# This is the implementation plan for mcu-debug cli

See [CLI Architecture](./cli-architecture.md) and [CLI Config](./cli-config.md)

[ ]Handle CLI args
   [ ]`args.config_name`   -c --config "Required: Debug Configuration name. Not case sensitive"
   [ ]`args.json_file`     -j --json-file "Optional: path to launch.json"
   [ ]`args.socket_path`   -s --socket-path "Optional: path name to use for socket"

[ ]Handle debug config
   [ ] If args.json_file was given we open just that file and look for config. If found "Handle unprocessed config"
   [ ] First look in ./.mcu-debug/debug-configurations/`arts.config_name`. If found, "Handle processed config"

[ ]Handle unprocessed config
  [ ] Resolve for serverPath, armtoolchainPath.
  [ ] for STLink, also resolve for the cube-programmer path
  [ ] TODO: Identify ALL the config properties that matter to us
      - debuggerArgs
      - serverArgs
      - type: launch vs attach
      - pre/post/override launch/attach commands
      - openOCD startup commands
      - rtt
      - uart
      - swo

[ ]Handle processed config
