import * as VAPI from "vapi";
import { asyncIter, asyncZip, enforce, enforce_nonnull } from "vscript";
import { setup_ptp } from "vutil/ptp.js";
import { scrub } from "vutil"; ///################################################################nach Fertigstellung herausnehmen
import { setup_sdi_io } from "vutil/sdi_connections.js";
import { stream_video } from "vutil/rtp_transmitter.js";
import { create_video_receiver } from "vutil/rtp_receiver.js";

const towel = "towel";
const vm = await VAPI.VM.open({ ip: "172.16.189.2", protocol: "ws", towel });
enforce(vm instanceof VAPI.AT1130.Root);
enforce(
  !!vm.video_signal_generator &&
    !!vm.genlock &&
    !!vm.re_play &&
    !!vm.i_o_module &&
    !!vm.color_correction &&
    !!vm.r_t_p_transmitter &&
    !!vm.r_t_p_receiver &&
    !!vm.video_mixer
);
console.log(`setup demosetup on blade ${vm.raw.ip}`);

//#############################################################################nach fertigstellung herausnehmen
const tx_kill = await vm.r_t_p_transmitter.sessions.rows();
for (const kill of tx_kill) {
  await kill.active.command.write(false);
}
await vm.r_t_p_transmitter.sessions.delete_all();
await vm.r_t_p_transmitter.video_transmitters.delete_all();
await scrub(vm);
console.log(`scrubed blade ${vm.raw.ip}`);
//Lists Videsources//
const framesyncs_videosources: VAPI.AT1130.Video.Essence[] = [];
const colorcorrection_videosources: VAPI.AT1130.Video.Essence[] = [];
const tx_videosources: VAPI.AT1130.Video.Essence[] = [];
const list_sdi_out_vsrc: VAPI.AT1130.Video.Essence[] = [];

//Setup PTP in Free Run Mode//
await setup_ptp(vm, { await_calibration: true, mode: "FreerunMaster" });
console.log(`setup PTP`);
const genlock = vm.genlock.instances.row(0).backend.output;

//######################################################################################//
//setup 8x 3G-Player - 2x Player Key&Fill Video (Logoanimation) // 2x Player Key&Fill Video (Still) // 4x Player (3G-Videos) //
//setup Player Key&Fill  Still Blade Runner Logo// ///TESTEN!!///
const number_key_fill_player_still = 2;
const names_key_fill_still = ["still_key", "still_fill"];
for (let i = 0; i < number_key_fill_player_still; i++) {
  const player = await vm.re_play.video.players.create_row({
    name: names_key_fill_still[i],
  });
  await player.capabilities.command.write({
    capacity: { variant: "Frames", value: { frames: 1 } },
    input_caliber: {
      add_blanking: false,
      constraints: { variant: "Bandwidth", value: { max_bandwidth: "b3_0Gb" } },
    },
  });
  await player.output.time.t_src.command.write(
    vm.genlock?.instances.row(0).backend.output
  );
}
//Setup player 0 as lead for player 1//
await vm.re_play.video.players
  .row(1)
  .gang.video.leader.command.write(vm.re_play.video.players.row(0));

console.log(
  `setup players: ${await vm.re_play.video.players
    .row(0)
    .raw.row_name()} & ${await vm.re_play.video.players.row(1).raw.row_name()}`
);

// setup Players Key&Fill arkona log Animation //
const number_key_fill_player_logo_animation = 2;
const names_key_fill_plyer_logo_animation = [
  "logo_animation_key",
  "logo_animation_fill",
];
for (let i = 0; i < number_key_fill_player_logo_animation; i++) {
  const player = await vm.re_play.video.players.create_row({
    name: names_key_fill_plyer_logo_animation[i],
  });
  await player.capabilities.command.write({
    capacity: { variant: "Frames", value: { frames: 100 } },
    input_caliber: {
      add_blanking: false,
      constraints: { variant: "Bandwidth", value: { max_bandwidth: "b3_0Gb" } },
    },
  });
  await player.output.time.t_src.command.write(
    vm.genlock?.instances.row(0).backend.output
  );
}
await vm.re_play.video.players
  .row(3)
  .gang.video.leader.command.write(vm.re_play.video.players.row(2));
console.log(
  `setup players: ${await vm.re_play.video.players
    .row(2)
    .raw.row_name()} & ${await vm.re_play.video.players.row(3).raw.row_name()}`
);

// setup Players Videoclips 3G //
const number_videoclips_player = 4;
const name_videoclips_player = ["clip1", "clip2", "clip3", "clip4"];
for (let i = 0; i < number_videoclips_player; i++) {
  const player = await vm.re_play.video.players.create_row({
    name: name_videoclips_player[i],
  });
  await player.capabilities.command.write({
    capacity: { variant: "Frames", value: { frames: 250 } },
    input_caliber: {
      add_blanking: false,
      constraints: { variant: "Bandwidth", value: { max_bandwidth: "b3_0Gb" } },
    },
  });
  await player.output.time.t_src.command.write(
    vm.genlock.instances.row(0).backend.output
  );
}
console.log(
  `setup players: ${await vm.re_play.video.players
    .row(4)
    .raw.row_name()}, ${await vm.re_play.video.players
    .row(5)
    .raw.row_name()}, ${await vm.re_play.video.players
    .row(6)
    .raw.row_name()}, ${await vm.re_play.video.players.row(7).raw.row_name()} `
);
//push videoclips_player in list tx_videosources && list colorcorrection_videosources//
const video_players = await vm.re_play.video.players.rows();
for (const vout of video_players) {
  const read_frames = (await vout.memory_usage.read()).as_requested.frames;
  if (read_frames && read_frames > 100) {
    await colorcorrection_videosources.push(vout.output.video);
    await tx_videosources.push(vout.output.video);
  }
}
console.log(
  `List Videosources Color Correction: ${colorcorrection_videosources}`
);
console.log(`List Videosources TX: ${tx_videosources}`);

//######################################################################################//
//Setup I/O-Module//
//Setup BNC's Inputs and Outputs//
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
//setup Inputs as SDI-Inputs//
const sdi_ins = await vm.i_o_module?.input.rows();
await asyncIter(sdi_ins, async (i) => {
  await i.mode.command.write("SDI");
});
//setup Outputs as SDI-Outpus//
const sdi_outs = await vm.i_o_module.output.rows();
await asyncIter(sdi_outs, async (o) => {
  await o.mode.command.write("SDI");
  await o.sdi.t_src.command.write(genlock);
});
console.log(`setup i/o-module`);
//push sdi ins in list of videosources color correction//
for (const vout of sdi_ins) {
  framesyncs_videosources.push(vout.sdi.output.video);
}
console.log(`list videosources framesyncs: ${colorcorrection_videosources}`);

//######################################################################################//
//Setup Framesyncs (3G) - 4x with panic freeze mode, 4x with black mode//
//Setup Framesync panic Freeze//
for (let i = 0; i < 4; i++) {
  const delay_panic_freeze = await vm.re_play.video.delays.create_row();
  await delay_panic_freeze.capabilities.command.write({
    capacity: { variant: "Frames", value: { frames: 1 } },
    delay_mode: "FrameSync_Freeze",
    input_caliber: {
      variant: "Single",
      value: {
        add_blanking: false,
        constraints: {
          variant: "Bandwidth",
          value: { max_bandwidth: "b3_0Gb" },
        },
      },
    },
  });
}
//Setup Framesync black mode//
for (let i = 0; i < 4; i++) {
  const delay_black_mode = await vm.re_play.video.delays.create_row();
  await delay_black_mode.capabilities.command.write({
    capacity: { variant: "Frames", value: { frames: 1 } },
    delay_mode: "FrameSync_Freeze",
    input_caliber: {
      variant: "Single",
      value: {
        add_blanking: false,
        constraints: {
          variant: "Bandwidth",
          value: { max_bandwidth: "b3_0Gb" },
        },
      },
    },
  });
}
//setup Outputs of Framesycns//s
const delays = await vm.re_play.video.delays.rows();
for (const out of delays) {
  const outs = await out.outputs.create_row();
  await outs.t_src.command.write(vm.genlock.instances.row(0).backend.output);
}
//Rout SDI Ins in Framesyncs
await asyncIter(delays, async (i) => {
  await i.inputs
    .row(0)
    .v_src.command.write(enforce_nonnull(framesyncs_videosources.shift()));
});
// //push output of framesyncs in list colorcorrection//
console.log(`setup videosource framesync`);
for (const i of delays) {
  for (const y of await i.outputs.rows()) {
    colorcorrection_videosources.push(y.video);
    tx_videosources.push(y.video);
  }
}
console.log(
  `Videosources in List Videosources Colorcorrection ${colorcorrection_videosources}`
);

///TO DO:
// - async Iter checken ob es durch async Zip ersetzt werden muss.
// - TX auffülen mit SDI ins
// - SDI Out auffüllen mit Receivern und anderem Processing Bums//######################################################################################//
//setup color correction//
//create colorcorrections//
const number_cc1d = 12;
for (let i = 0; i < number_cc1d; i++) {
  const cc1d = await vm.color_correction.cc1d.create_row();
  await cc1d.rgb.active.command.write(true);
  await cc1d.reserve_uhd_resources.command.write(false);
}
const cc1d = await vm.color_correction.cc1d.rows();
await asyncIter(cc1d, async (i) => {
  await i.v_src.command.write(
    enforce_nonnull(colorcorrection_videosources.shift())
  );
});
//puhs cc1d in list videosources_tx//
for (const vout of cc1d) {
  tx_videosources.push(vout.output);
}
console.log(`List videosources tx: ${tx_videosources}`);

///#####################################################################################//
//set SDI-In as Streaming Source//
for (const vout of sdi_ins) {
 tx_videosources.push(vout.sdi.output.video);
}
//######################################################################################//
//Setup Videostreams SDI Ins and Color Corrections//
const number_tx_videosources = tx_videosources.length;
console.log(`Setup Streams for Videosources: ${number_tx_videosources}`);
for (let i = 0; i < number_tx_videosources; i++) {
  await stream_video(enforce_nonnull(tx_videosources.shift()), {
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
const tx = await vm.r_t_p_transmitter.sessions.rows();
const num_tx = tx.length;
console.log(`Setup Tx: ${num_tx}`);

///####################################################################################################
//Setup RX//
for (let i = 0; i < num_tx; i++) {
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

console.log(`TEST!!!`);
const video_receivers_sessions = await vm.r_t_p_receiver.sessions.rows();
const num_video_receveirs = video_receivers_sessions.length;
console.log(`setup RX: ${num_video_receveirs}`);

//Connect TX-RX//
await asyncZip(video_receivers_sessions, tx, async (vr, tx) => {
  await vr.active.command.write(false);
  await vr.interfaces.command.write({
    primary: vm.network_interfaces.ports.row(1).virtual_interfaces.row(0),
    secondary: vm.network_interfaces.ports.row(0).virtual_interfaces.row(0),
  });
  await vr.set_sdp("A", enforce_nonnull(await tx.sdp_a.read()));
  await vr.active.command.write(true);
});
//################################################################################################
// Setup Videomixer//
// /Setup Videomixer - Luma Keyer//
const number_videomixer_ab_mixer = 2;
for (let i = 0; i < number_videomixer_ab_mixer; i++) {
  const vmixer_ab = await vm.video_mixer?.instances.create_row();
  await vmixer_ab?.mode.write("MIXER");
  await vmixer_ab?.t_src.command.write(genlock);
}

await vm.video_mixer.instances
  .row(0)
  .v_src0.command.write(vm.re_play.video.delays.row(0).outputs.row(0).video);
await vm.video_mixer.instances
  .row(0)
  .v_src1.command.write(
    vm.r_t_p_receiver.video_receivers.row(10).media_specific.output.video
  );
await vm.video_mixer.instances
  .row(1)
  .v_src0.command.write(
    vm.r_t_p_receiver.video_receivers.row(8).media_specific.output.video
  );
await vm.video_mixer.instances
  .row(1)
  .v_src1.command.write(vm.color_correction.cc1d.row(10).output);
console.log(`seutp videomixer ab-modus`);

//seutp Luma-Keyer Mixer//
const number_videomixer_luma_keyer = 2;
for (let i = 0; i < number_videomixer_luma_keyer; i++) {
  const vmixer_luma_keyer = await vm.video_mixer?.instances.create_row();
  await vmixer_luma_keyer.mode.write("LUMA_KEYER");
  await vmixer_luma_keyer.t_src.command.write(genlock);
}
const vmixer_2 = await vm.video_mixer.instances.row(2);
const vmixer_3 = await vm.video_mixer.instances.row(3);

await vmixer_2.v_src0.command.write(
  vm.r_t_p_receiver.video_receivers.row(10).media_specific.output.video
);
await vmixer_2.v_src1.command.write(
  vm.re_play.video.players.row(1).output.video
);
await vmixer_2.luma_keyer.v_src.command.write(
  vm.re_play.video.players.row(0).output.video
);

await vmixer_3.v_src0.command.write(
  vm.r_t_p_receiver.video_receivers.row(10).media_specific.output.video
);
await vmixer_3.v_src1.command.write(
  vm.re_play.video.players.row(3).output.video
);
await vmixer_3.luma_keyer.v_src.command.write(
  vm.re_play.video.players.row(2).output.video
);

console.log(`setup videomixer lum keyer mode`);

//#############################################################################################
//set vmixer als sdi outputs
//push videoouts videmixer in list vsrc sdi out//
const videomixer = await vm.video_mixer.instances.rows();
for (const out of videomixer) {
  list_sdi_out_vsrc.push(out.output);
}
console.log(`push vmixer outs in list`);
console.log(`${list_sdi_out_vsrc}`)
//push videoreceivers in list of vsrc sdi out//
const video_receivers = await vm.r_t_p_receiver.video_receivers.rows();
for (const vout of video_receivers) {
  list_sdi_out_vsrc.push(vout.media_specific.output.video);
}

//set vsrcs of sdi-outs//
const sdi_outs_vsrc = await vm.i_o_module.output.rows();
await asyncZip(sdi_outs_vsrc, list_sdi_out_vsrc, async (o) => {
  await o.sdi.v_src.command.write({
    source: enforce_nonnull(list_sdi_out_vsrc.shift()),
    switch_time: null,
  });
});

//closed Websocket Connection//
await vm.close();
console.log(`feddich`);