import * as VAPI from "vapi";
import { Standard } from "vapi/Video";
import {
  Duration,
  asyncIter,
  asyncZip,
  enforce,
  enforce_nonnull,
  pause,
} from "vscript";
import { scrub, video_ref } from "vutil"; ///################################################################nach Fertigstellung herausnehmen
import { setup_ptp } from "vutil/ptp.js";
import { create_video_receiver } from "vutil/rtp_receiver.js";
import { stream_video } from "vutil/rtp_transmitter.js";
import { setup_sdi_io } from "vutil/sdi_connections.js";

const towel = "towel";
const blade_left = process.env["BLADE_LEFT"];
const blade_right = process.env["BLADE_RIGHT"];
type ReplayType = "fill" | "key" | "clip" | "fs";
interface SP {
  name: string;
  frames: number;
  leader?: number;
  related?: number;
  type: ReplayType;
}
interface PS {
  replays: SP[];
}
const PlayerSettings: PS = {
  replays: [
    { name: "still_key", frames: 1, type: "key", related: 1 },
    { name: "still_fill", frames: 1, type: "fill" },
    { name: "logo_animation_key", frames: 150, type: "key", related: 3 },
    { name: "logo_animation_fill", frames: 1, leader: 2, type: "fill" },
    { name: "clip1", frames: 250, type: "clip" },
    { name: "clip2", frames: 250, type: "clip" },
    { name: "clip3", frames: 250, type: "clip" },
    { name: "clip4", frames: 250, type: "clip" },
  ],
};
const DelaysSettings: PS = {
  replays: [
    { name: "fs_sdi0", frames: 1, type: "fs" },
    { name: "fs_sdi1", frames: 1, type: "fs" },
    { name: "fs_sdi2", frames: 1, type: "fs" },
    { name: "fs_sdi3", frames: 1, type: "fs" },
    { name: "fs_sdi4", frames: 1, type: "fs" },
    { name: "fs_sdi5", frames: 1, type: "fs" },
    { name: "fs_sdi6", frames: 1, type: "fs" },
    { name: "fs_sdi7", frames: 1, type: "fs" },
  ],
};

interface Mixer {
  name: string;
  mode: VAPI.VideoMixer.BSLKMode;
}

const MixerSettings: Mixer[] = [
  { name: "VidMixer0", mode: "MIXER" },
  { name: "VidMixer1", mode: "MIXER" },
  { name: "DSK0", mode: "LUMA_KEYER" },
  { name: "DSK1", mode: "LUMA_KEYER" },
];

const USE_STD: Standard = "HD1080p50"; //Insert videostandard that should be used for demo.
const NUM_CC: number = 12;
const NUM_RXTXS: number = 32;

const delete_all = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.r_t_p_transmitter && !!vm.r_t_p_receiver);
  const tx_kill = await vm.r_t_p_transmitter.sessions.rows();
  for (const kill of tx_kill) {
    await kill.active.command.write(false);
  }
  await vm.r_t_p_transmitter.sessions.delete_all();
  await vm.r_t_p_transmitter.video_transmitters.delete_all();
  const rx_kill = await vm.r_t_p_receiver.sessions.rows();
  for (const kill of rx_kill) {
    await kill.active.command.write(false);
  }
  await vm.r_t_p_receiver.sessions.delete_all();
  await vm.r_t_p_receiver.video_receivers.delete_all();
  await scrub(vm);
};

const setup_timing = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.genlock);
  await setup_ptp(vm, { await_calibration: true, mode: "FreerunMaster" });
  console.log("setup PTP");
  vm.genlock.instances.row(0).backend.output;
};

const setup_players = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.re_play && !!vm.genlock);
  const gen = vm.genlock.instances.row(0).backend.output;
  const cap: VAPI.VideoPlayer.Capabilities = {
    capacity: { variant: "Frames", value: { frames: 1 } },
    input_caliber: {
      add_blanking: false,
      constraints: { variant: "Bandwidth", value: { max_bandwidth: "b3_0Gb" } },
    },
  };
  const players = await vm.re_play.video.players.ensure_allocated(
    PlayerSettings.replays.length,
    "exactly"
  );
  await asyncZip(players, PlayerSettings.replays, async (player, pl_set) => {
    await player.capabilities.command.write({
      ...cap,
      capacity: { variant: "Frames", value: { frames: pl_set.frames } },
    });
    await player.output.time.t_src.command.write(gen);
    await player.rename(pl_set.name);
    if (pl_set.leader && pl_set.leader < players.length) {
      player.gang.video.leader.command.write(players[pl_set.leader]);
    }
  });
};

const setup_delays = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.re_play && !!vm.genlock);
  const gen = vm.genlock.instances.row(0).backend.output;
  const cap: VAPI.VideoRePlay.Capabilities = {
    delay_mode: "FrameSync_Freeze",
    capacity: { variant: "Frames", value: { frames: 1 } },
    input_caliber: {
      variant: "Single",
      value: {
        add_blanking: true,
        constraints: {
          variant: "Bandwidth",
          value: { max_bandwidth: "b3_0Gb" },
        },
      },
    },
  };
  const delays = await vm.re_play.video.delays.ensure_allocated(
    DelaysSettings.replays.length,
    "exactly"
  );
  await asyncZip(delays, DelaysSettings.replays, async (delay, pl_set) => {
    await delay.capabilities.command.write({
      ...cap,
      capacity: { variant: "Frames", value: { frames: pl_set.frames } },
    });
    const output = await delay.outputs.create_row();
    await output.t_src.command.write(gen);
    await delay.rename(pl_set.name);
  });
};

const setup_sdi = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.i_o_module && !!vm.genlock);
  const read_io = await vm.system.io_board.info.type.read();
  console.log(`detected I/O-Module: ${read_io}`);
  if (read_io === "IO_BNC_16bidi" || read_io === "IO_BNC_16bidi_GD32") {
    const gen = vm.genlock.instances.row(0).backend.output;
    const io = vm.i_o_module;
    await setup_sdi_io(vm, {
      directions: [
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Output",
        "Output",
        "Output",
        "Output",
        "Output",
        "Output",
        "Output",
        "Output",
      ],
    });
    await asyncIter(await io.input.rows(), async (i) => {
      await i.mode.command.write("SDI");
    });
    await asyncIter(await io.output.rows(), async (o) => {
      await o.mode.command.write("SDI");
      await o.sdi.t_src.command.write(gen);
      await o.sdi.phase_target.command.write(new Duration(3, "µs"));
    });
  }
  if (
    read_io === "IO_MSC_v2_GD32" ||
    read_io === "IO_MSC_v2" ||
    read_io === "IO_MSC_v1"
  ) {
    const gen = vm.genlock.instances.row(0).backend.output;
    const io = vm.i_o_module;
    await setup_sdi_io(vm, {
      directions: [
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Input",
        "Output",
        "Output",
      ],
    });
    await asyncIter(await io.input.rows(), async (i) => {
      await i.mode.command.write("SDI");
    });
    await asyncIter(await io.output.rows(), async (o) => {
      await o.mode.command.write("SDI");
      await o.sdi.t_src.command.write(gen);
      await o.sdi.phase_target.command.write(new Duration(3, "µs"));
    });
  }
};

const setup_cc = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.color_correction);
  const ccs = await vm.color_correction.cc1d.ensure_allocated(
    NUM_CC,
    "exactly"
  );
  await asyncIter(ccs, async (cc) => {
    await cc.rgb.active.command.write(true);
    await cc.reserve_uhd_resources.command.write(false);
  });
};
const setup_tx = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.r_t_p_transmitter && !!vm.video_signal_generator);
  for (let i = 0; i < NUM_RXTXS; i++) {
    await stream_video(vm.video_signal_generator.instances.row(0).output, {
      transport_format: {
        variant: "ST2110_20",
        value: {
          add_st2110_40: false,
          transmit_scheduler_uhd: false,
          packing_mode: "BPM",
        },
      },
      constrain: false,
    });
  }
  const tx_session = await vm.r_t_p_transmitter.sessions.rows();
  const videotransmitter = await vm.r_t_p_transmitter.video_transmitters.rows();
  for (const stop of tx_session) {
    await stop.active.command.write(false);
  }
  for (const bandwith of videotransmitter) {
    await bandwith.constraints.max_bandwidth.command.write("b3_0Gb");
  }
  for (const start_tx of tx_session) {
    await start_tx.active.command.write(true);
  }
};

const setup_rx = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.r_t_p_receiver);
  for (let i = 0; i < NUM_RXTXS; i++) {
    await create_video_receiver(vm, {
      jpeg_xs_caliber: null,
      supports_2022_6: false,
      supports_uhd_sample_interleaved: false,
      supports_2110_40: false,
      supports_clean_switching: true,
      st2110_20_caliber: "ST2110_upto_3G",
      st2042_2_caliber: "ST2042_2_upto_3G",
    });
  }
  const video_receivers_sessions = await vm.r_t_p_receiver.sessions.rows();
  const num_video_receveirs = video_receivers_sessions.length;
  console.log(`setup RX: ${num_video_receveirs}`);
};

const tx_rx_patching = async (
  vm_source: VAPI.AT1130.Root,
  vm_destination: VAPI.AT1130.Root
) => {
  enforce(
    !!vm_source.r_t_p_transmitter &&
      !!vm_source.video_signal_generator &&
      !!vm_destination.r_t_p_receiver
  );
  const rxss = await vm_destination.r_t_p_receiver.sessions.rows();
  const txvs = await vm_source.r_t_p_transmitter.video_transmitters.rows();
  const vsg = vm_source.video_signal_generator.instances.row(0);

  await vsg.standard.command.write(USE_STD);
  await vsg.pattern.write("Colorbars100");
  await asyncZip(txvs, rxss, async (txv, rxs) => {
    await txv.v_src.command.write(video_ref(vsg.output));
    await pause(new Duration(100, "ms"));
    await rxs.set_sdp(
      "A",
      enforce_nonnull(await txv.generic.ip_configuration.sdp_a.read())
    );
  });
};

const setup_mixer = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.video_mixer && !!vm.genlock);
  const vms = await vm.video_mixer.instances.ensure_allocated(
    MixerSettings.length,
    "exactly"
  );
  const gen = vm.genlock?.instances.row(0);
  await asyncZip(vms, MixerSettings, async (v_m, ms) => {
    await v_m.mode.write(ms.mode);
    await v_m.rename(ms.name);
    await v_m.t_src.command.write(gen.backend.output);
  });
};

const get_usb_dongle_media_files = async (vm: VAPI.AT1130.Root) => {
  const dirs: string[] = [];
  const files = {};
  const media = await fetch(
    `${vm.raw.protocol === "ws" ? "http:" : "https:"}//${vm.raw.ip}/media`
  ).then((d) => d.json());
  for (const [key, value] of Object.entries(media)) {
    if (value instanceof Object && "type" in value && value.type === "dir")
      dirs.push(`/media/${key}`);
  }
  for (const key of dirs) {
    files[key] ??= {};
    await fetch(
      `${vm.raw.protocol === "ws" ? "http:" : "https:"}//${
        vm.raw.ip
      }/media/${key}`
    )
      .then((d) => d.json())
      .then((d) => {
        for (const [name, object] of Object.entries(d)) {
          if (
            object instanceof Object &&
            "type" in object &&
            object.type === "file"
          )
            files[key][name] = object;
        }
      });
  }
  return files;
};

const check_and_upload_bids = async (vm: VAPI.AT1130.Root) => {
  enforce(!!vm.re_play);
  const availableFiles = await get_usb_dongle_media_files(vm);
  const std = USE_STD.replace("HD", "");
  const clipsStills = {
    still_key: `${std}_blade_runner_logo_key.bid`,
    still_fill: `${std}_blade_runner_logo_fill.bid`,
    logo_animation_key: `${std}_3G_key_arkona_logo_animation.bid`,
    logo_animation_fill: `${std}_3G_fill_arkona_logo_animation.bid`,
    clip1: `clip_1_${std}_3G_250frames.bid`,
    clip2: `clip_2_${std}_3G_250frames.bid`,
    clip3: `clip_3_${std}_3G_250frames.bid`,
    clip4: `clip_4_${std}_3G_250frames.bid`,
  };
  let checked = true;
  const checkedDirs: boolean[] = [];
  await asyncIter(Object.keys(availableFiles), async (dir) => {
    const checkinDir: boolean[] = [];
    await asyncIter(Object.entries(clipsStills), async ([key, file]) => {
      if (file in availableFiles[dir]) {
        // console.log("found file:", [dir, file].join("/"));
        clipsStills[key] = [dir, file].join("/");
        checkinDir.push(true);
      } else {
        // console.log("file missing:", file);
        checkinDir.push(false);
      }
    });
    if (checkinDir.includes(false)) checkedDirs.push(false);
    else checkedDirs.push(true);
  });
  checked = checkedDirs.includes(true);

  console.log(
    checked
      ? "Clips available on dongle, uploading..."
      : "Clips not found on media device, you can upload those manually"
  );
  if (checked) {
    const players = await vm.re_play.video.players.ensure_allocated(
      PlayerSettings.replays.length,
      "exactly"
    );
    await asyncIter(players, async (player) => {
      const name = await player.row_name();
      await player.upload.load.file.command.write(clipsStills[name]);
      await player.upload.load.load.write("Click");
    });
  }
};

const connection = async (
  vm: VAPI.AT1130.Root,
  mode: "OneToOne" | "FillUp"
) => {
  enforce(
    !!vm.r_t_p_transmitter &&
      !!vm.re_play &&
      !!vm.i_o_module &&
      !!vm.r_t_p_receiver &&
      !!vm.video_signal_generator &&
      !!vm.color_correction &&
      !!vm.video_mixer
  );
  console.log(mode);
  const vsg = vm.video_signal_generator.instances.row(0).output;
  const inps = await vm.i_o_module.input.rows();
  const outs = await vm.i_o_module.output.rows();
  const txs = await vm.r_t_p_transmitter.video_transmitters.rows();
  const ccs = await vm.color_correction.cc1d.rows();
  const pls = await vm.re_play.video.players.rows();
  const dlys = await vm.re_play.video.delays.rows();
  const rxvs = await vm.r_t_p_receiver.video_receivers.rows();
  const raw_vms = await vm.video_mixer.instances.rows();
  const dsks: VAPI.AT1130.VideoMixer.BSLKAsNamedTableRow[] = [];
  const vms: VAPI.AT1130.VideoMixer.BSLKAsNamedTableRow[] = [];
  await asyncIter(raw_vms, async (v_m) => {
    const mode = await v_m.mode.read();
    if (mode === "LUMA_KEYER") dsks.push(v_m);
    else vms.push(v_m);
  });
  await pause(new Duration(1, "s"));
  await asyncIter(PlayerSettings.replays, async (player, index) => {
    if (player.type === "clip" && index < pls.length) {
      const tx = txs.shift();
      if (tx) await tx.v_src.command.write(video_ref(pls[index].output.video));
      const cc = ccs.shift();
      if (cc) {
        await cc.v_src.command.write(pls[index].output.video);
        const tx = txs.shift();
        if (tx) await tx.v_src.command.write(video_ref(cc.output));
      }
    }
    if (player.type === "key" && player.related) {
      const rel = player.related;
      const dsk = dsks.shift();
      //const rxv = rxvs.shift();
      const rxv = vm.r_t_p_receiver?.video_receivers.row(8);
      const out = outs.shift();
      if (dsk && rel < pls.length) {
        //await dsk.v_src0.command.write(rxv ? rxv.media_specific.output.video : vsg)
        await dsk.v_src0.command.write(
          rxv ? rxv.media_specific.output.video : vsg
        );
        await dsk.v_src1.command.write(pls[rel].output.video);
        await dsk.luma_keyer.v_src.command.write(pls[index].output.video);
        if (out) await out.sdi.v_src.command.write(video_ref(dsk.output));
      }
    }
  });
  await asyncIter(dlys, async (dly) => {
    const cc = ccs.shift();
    if (cc) {
      await cc.v_src.command.write(dly.outputs.row(0).video);
      const tx = txs.shift();
      if (tx) await tx.v_src.command.write(video_ref(cc.output));
    }
  });
  await asyncIter(vms, async (v_m, index) => {
    if (index * 2 + 1 < dlys.length) {
      await v_m.v_src0.command.write(dlys[index * 2].outputs.row(0).video);
      await v_m.v_src1.command.write(dlys[index * 2 + 1].outputs.row(0).video);
      const out = outs.shift();
      if (out) await out.sdi.v_src.command.write(video_ref(v_m.output));
    }
  });
  await asyncIter(dlys, async (dly, index) => {
    const tx = txs.shift();
    if (tx) await tx.v_src.command.write(video_ref(dly.outputs.row(0).video));
    if (index < inps.length) {
      await dly.inputs.row(0).v_src.command.write(inps[index].sdi.output.video);
    }
  });
  await asyncIter(inps, async (inp) => {
    const tx = txs.shift();
    if (tx) await tx.v_src.command.write(video_ref(inp.sdi.output.video));
  });
  await asyncIter(outs, async (out) => {
    const rx = rxvs.shift();
    if (rx)
      await out.sdi.v_src.command.write(
        video_ref(rx.media_specific.output.video)
      );
  });
  const read_io = await vm.system.io_board.info.type.read();
  if (
    read_io === "IO_MSC_v2_GD32" ||
    read_io === "IO_MSC_v2" ||
    read_io === "IO_MSC_v1"
  ) {
    await vm.i_o_module.output
      .row(8)
      .sdi.v_src.command.write(
        video_ref(vm.video_mixer.instances.row(0).output)
      );
  }
};

async function run() {
  const vm_left = await VAPI.VM.open({
    ip: blade_left || "",
    protocol: "ws",
    towel,
  });
  const vm_right = await VAPI.VM.open({
    ip: blade_right || "",
    protocol: "ws",
    towel,
  });
  enforce(vm_left instanceof VAPI.AT1130.Root);
  enforce(vm_right instanceof VAPI.AT1130.Root);
  console.log(
    `Setup demo on left blade ${vm_left.raw.ip} & right blade ${vm_right.raw.ip}`
  );
  await delete_all(vm_left);
  await delete_all(vm_right);
  await setup_timing(vm_left);
  await setup_timing(vm_right);
  await setup_sdi(vm_left);
  await setup_sdi(vm_right);
  await setup_players(vm_left);
  await setup_players(vm_right);
  await setup_delays(vm_left);
  await setup_delays(vm_right);
  await setup_cc(vm_left);
  await setup_cc(vm_right);
  await setup_tx(vm_left);
  await setup_tx(vm_right);
  await setup_rx(vm_left);
  await setup_rx(vm_right);
  await tx_rx_patching(vm_left, vm_right);
  await tx_rx_patching(vm_right, vm_left);
  await setup_mixer(vm_left);
  await setup_mixer(vm_right);
  await connection(vm_left, "FillUp");
  await connection(vm_right, "FillUp");
  await check_and_upload_bids(vm_left);
  await check_and_upload_bids(vm_right);
  await vm_left.close();
  await vm_right.close();
}

await run();
