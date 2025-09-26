//Script for setup a demosetup of single blade with autodetected IO-Boards for a Easy IP Router Demo.
//This script checks if the at300 FPGA "AVP" is loaded, set the ptp of FreeRun and dected wish io-module is connected.
//This Should work in a Standalone Version or with a switch.
//For Multicast Adresses the vutil function "stream video" is used - this used the scheme of
//the rear management address to create mcast - addresses.

//To do:
// PTP DOMAIN AM ENDE ENTFERNEN UND AUF DEFAULT 127 gehen.
// PRO SDI INPUT SRCs AUFSETZEN - Done
// 16x Videoplayer with internal videoclips
// PRO SDI INPUT VIDEO/AUDIO TRANSMITTER AUFSETZEN - done
// PRO SDI OUTPUT VIDEO/AUDIO RECEIVER AUFSETZEN - done
// PRO SDI INPUT / OUTPUT AUDIOSHUFFLER AUFSETZEN - done
// Naming of Transmitter - done
// Restart Ember - done
// Setup 2x UHD Receiver for MV-Heads done (Varibales auslesen der Nummern noch einbauen grad hard gecodet drin)

import * as VAPI from "vapi";
import {
  asyncIter,
  asyncZip,
  Duration,
  enforce,
  enforce_nonnull,
  pause,
} from "vscript";
import { setup_ptp } from "vutil/ptp.js";
import { audio_ref, scrub, video_ref } from "vutil";
import { stream_audio, stream_video } from "vutil/rtp_transmitter";
import {
  create_audio_receiver,
  create_video_receiver,
} from "vutil/rtp_receiver";
import * as FS from "fs";

const vm = await VAPI.VM.open({});
enforce(vm instanceof VAPI.AT1130.Root);
enforce(
  !!vm.i_o_module &&
    !!vm.genlock &&
    !!vm.video_signal_generator &&
    !!vm.sample_rate_converter
);

//setup general_config.json file for ember
async function checkup_ember() {
  if (FS.existsSync("/config/ember/config_general_16.json")) {
    FS.copyFileSync(
      "/config/ember/config_general_16.json",
      "/config/ember/config_general.json"
    );
  } else {
    process.exit(`no /config/ember/`);
  }
}

//Setup Videosignalgenerator
async function setup_vsg(vm: VAPI.AT1130.Root) {
  enforce(!!vm.video_signal_generator && !!vm.genlock);
  console.log(`setting up videosignalgenerator`);
  await vm.video_signal_generator.instances
    .row(0)
    .t_src.command.write(vm.genlock.instances.row(0).backend.output);
  await vm.video_signal_generator.instances
    .row(0)
    .standard.command.write("HD1080p59_94");
}

//Read out io-module variant
async function setup_io_module(vm: VAPI.AT1130.Root) {
  try {
    enforce(!!vm.i_o_module && !!vm.genlock && !!vm.video_signal_generator);
    const io_module_version = await vm.system.io_board.info.type.read();
    console.log(`io-module version: ${io_module_version}`);

    if (
      io_module_version == "IO_BNC_16bidi" ||
      io_module_version == "IO_BNC_16bidi_GD32" ||
      io_module_version == "IO_MSC_v2" ||
      io_module_version == "IO_MSC_v2_GD32"
    ) {
      const config_bnc_input =
        (await vm.i_o_module.configuration.rows()).length / 2;
      console.log(`number of sid inputs: ${config_bnc_input}`);
      for (let i = 0; i < config_bnc_input; i++) {
        await vm.i_o_module.configuration.row(i).direction.write("Input");
        await vm.i_o_module.configuration
          .row(i + config_bnc_input)
          .direction.write("Output");
      }
    } else {
      console.log(
        `io-module with fixed sid directions connected: ${io_module_version}`
      );
    }
    const all_sdi_outs = await vm.i_o_module.output.rows();
    for (const settings of all_sdi_outs) {
      await settings.sdi.t_src.command.write(
        vm.genlock.instances.row(0).backend.output
      );
      await settings.sdi.v_src.command.write({
        source: vm.video_signal_generator.instances.row(0).output,
        switch_time: null,
      });
      await settings.sdi.embedded_audio.command.write([
        "Embed",
        "Embed",
        "Embed",
        "Embed",
        "Off",
        "Off",
        "Off",
        "Off",
      ]);
    }
    const all_sdi_inputs = await vm.i_o_module.input.rows();
    for (const settings of all_sdi_inputs) {
      await settings.audio_timing.command.write({
        variant: "Asynchronous",
        value: { frequency: "F48000" },
      });
    }
  } catch (e) {
    console.log(e, "no io-board detected");
  }
  console.log(`finishd setup sdi io-board`);
}

//Function to setup samplerate_converter
async function setup_samplerate_converter(vm: VAPI.AT1130.Root) {
  try {
    //setting up srcs
    console.log(`setting up audio srcs`);
    enforce(!!vm.i_o_module && !!vm.sample_rate_converter);
    //Number of SDI Inputs
    const number_sdi_inputs = (await vm.i_o_module.input.rows()).length;

    await asyncIter(new Array<number>(number_sdi_inputs), async (_, i) => {
      enforce(
        !!vm.sample_rate_converter &&
          !!vm.genlock &&
          !!vm.i_o_module &&
          !!vm.audio_shuffler
      );
      const gen = vm.genlock.instances.row(0).backend.output;
      const src = await vm.sample_rate_converter.instances.create_row();
      await src.settings.t_src.command.write(gen);
      await src.settings.channel_capacity.command.write(16);
      await src.a_src.command.write(
        vm.i_o_module.input.row(i).sdi.output.audio
      );
      await src.active.command.write(true);
    });
    const number_srcs = (await vm.sample_rate_converter.instances.rows())
      .length;
    console.log(`number of samplerate converter: ${number_srcs}`);
  } catch (e) {
    console.log(`error while setting up src: ${e}`);
  }
}

//Function to setup Input Audioshuffler
async function setup_input_audio_shuffler(vm: VAPI.AT1130.Root) {
  enforce(!!vm.sample_rate_converter);
  const number_srcs = (await vm.sample_rate_converter.instances.rows()).length;
  await asyncIter(new Array<number>(number_srcs), async (_, i) => {
    enforce(!!vm.sample_rate_converter && !!vm.genlock && !!vm.audio_shuffler);
    const audio_shuffler = await vm.audio_shuffler.instances.create_row();
    await audio_shuffler.genlock.command.write(vm.genlock.instances.row(0));
    let update: any = {};
    for (let index = 0; index < 16; index++) {
      update[index] = vm.sample_rate_converter.instances
        .row(i)
        .output.channels.reference_to_index(index);
    }
    await audio_shuffler.a_src.command.write(update);
  });
}

//Load Clips from USB Stick
//Hier entsteht bestimmt noch super Code

//Setup Transmitters
async function setup_video_audio_transmitters(vm: VAPI.AT1130.Root) {
  enforce(
    !!vm.audio_shuffler &&
      !!vm.i_o_module &&
      !!vm.re_play &&
      !!vm.video_signal_generator &&
      !!vm.audio_signal_generator
  );
  enforce(!!vm.r_t_p_transmitter);
  const videosource_vsg = vm.video_signal_generator.instances.row(0).output;
  const audiosource =
    vm.audio_signal_generator.genlock.row(0).f48000.signal_1000hz.output;
  const audio_shuffler = await vm.audio_shuffler.instances.rows();

  const sdi_inputs = await vm.i_o_module.input.rows();
  console.log(`number of sdi inputs: ${sdi_inputs.length}`);

  await asyncIter(sdi_inputs, async () => {
    await stream_video(videosource_vsg);
  });

  await asyncIter(sdi_inputs, async () => {
    await stream_audio(audiosource);
  });

  const txs_v = await vm.r_t_p_transmitter.video_transmitters.rows();
  const txs_a = await vm.r_t_p_transmitter.audio_transmitters.rows();
  await asyncZip(txs_v, txs_a, async (tx_v, tx_a) => {
    const sess_v = enforce_nonnull(
      await tx_v.generic.hosting_session.status.read()
    );
    const sess_a = enforce_nonnull(
      await tx_a.generic.hosting_session.status.read()
    );
    await sess_a.active.command.write(false);
    await sess_v.active.command.write(false);
    await tx_a.generic.hosting_session.command.write(sess_v);
    await sess_v.active.command.write(true);
  });
  await asyncIter(await vm.r_t_p_transmitter.sessions.rows(), async (sess) => {
    if ((await sess.active.status.read()) === false) sess.delete();
  });

  const sessions = await vm.r_t_p_transmitter.sessions.rows();
  await asyncZip(sdi_inputs, txs_v, async (inp, tx, idx) => {
    const src = await inp.sdi.hw_status.standard.read();
    tx.v_src.command.write(
      video_ref(src === null ? videosource_vsg : inp.sdi.output.video)
    );
    const name = `${src === null ? "VSG" : "SDI"}_${idx}`;
    await tx.rename(name);
    if (idx < sessions.length) sessions[idx].rename(name);
  });
  await asyncZip(sdi_inputs, txs_a, async (inp, tx, idx) => {
    const src = await inp.sdi.hw_status.standard.read();
    tx.a_src.command.write(
      audio_ref(
        src === null
          ? audiosource
          : idx < audio_shuffler.length
          ? audio_shuffler[idx].output
          : audiosource
      )
    );
    const name = `${
      src === null ? "ASG" : idx < audio_shuffler.length ? "A_Shuffler" : "ASG"
    }_${idx}`;
    await tx.rename(name);
  });
}
//Setup Receiver
async function setup_video_audio_receiver(vm: VAPI.AT1130.Root) {
  enforce(!!vm.r_t_p_receiver && !!vm.i_o_module && !!vm.genlock);
  const sdi_outputs = await vm.i_o_module.output.rows();
  console.log(`number of sdi outputs: ${sdi_outputs.length}`);

  await asyncIter(sdi_outputs, async (_, i) => {
    const num_sdi_outputs = sdi_outputs.length;
    if (i > num_sdi_outputs - 3) {
      await create_video_receiver(vm, {
        st2110_20_caliber: "ST2110_singlelink_uhd",
        read_speed: {
          variant: "LockToGenlock",
          value: { genlock: vm.genlock?.instances.row(0) },
        },
        supports_clean_switching: true,
        supports_uhd_sample_interleaved: true,
        supports_2022_6: false,
        supports_2110_40: false,
        jpeg_xs_caliber: null,
        st2042_2_caliber: null,
      });
      await vm.r_t_p_receiver?.video_receivers.row(i).rename(`HEAD_0`);
      await vm.r_t_p_receiver?.sessions.row(i).rename(`HEAD_1`);
    } else {
      await create_video_receiver(vm, {
        st2110_20_caliber: "ST2110_upto_3G",
        read_speed: {
          variant: "LockToGenlock",
          value: { genlock: vm.genlock?.instances.row(0) },
        },
        supports_clean_switching: true,
        supports_uhd_sample_interleaved: false,
        supports_2022_6: false,
        supports_2110_40: true,
        jpeg_xs_caliber: null,
        st2042_2_caliber: null,
      });
      await vm.r_t_p_receiver?.video_receivers.row(i).rename(`SDI_${i}`);
      await vm.r_t_p_receiver?.sessions.row(i).rename(`SDI_${i}`);
    }
  });
  await asyncIter(sdi_outputs, async (_, i) => {
    const num_sdi_outputs = sdi_outputs.length;
    if (i < num_sdi_outputs) {
      await create_audio_receiver(vm, {
        channel_capacity: 16,
        supports_clean_switching: true,
        payload_limit: "AtMost960Bytes",
        read_speed: {
          variant: "LockToGenlock",
          value: { genlock: vm.genlock?.instances.row(0) },
        },
      });
    }
    await vm.r_t_p_receiver?.audio_receivers.row(i).rename(`SDI_${i}`);
  });
  const rxs_v = await vm.r_t_p_receiver.video_receivers.rows();
  const rxs_a = await vm.r_t_p_receiver.audio_receivers.rows();
  await asyncZip(rxs_v, rxs_a, async (rx_v, rx_a) => {
    const sess_v = enforce_nonnull(
      await rx_v.generic.hosting_session.status.read()
    );
    const sess_a = enforce_nonnull(
      await rx_a.generic.hosting_session.status.read()
    );
    await sess_a.active.command.write(false);
    await sess_v.active.command.write(false);
    await rx_a.generic.hosting_session.command.write(sess_v);
    await rx_a.generic.timing.target.command.write({
      variant: "ForeignReadDelay",
      value: {
        foreign_receiver: rx_v.generic,
        extra_delay: new Duration(0, "s"),
        on_backpressure: "Yield",
      },
    });
    await sess_v.active.command.write(true);
  });
  await asyncIter(await vm.r_t_p_receiver.sessions.rows(), async (sess) => {
    if ((await sess.active.status.read()) === false) sess.delete();
  });
}

async function patch_rx_audio_video_to_sdi_out(vm: VAPI.AT1130.Root) {
  enforce(!!vm.i_o_module && !!vm.r_t_p_receiver);
  const rxs_v = await vm.r_t_p_receiver.video_receivers.rows();
  const rxs_a = await vm.r_t_p_receiver.audio_receivers.rows();
  const sdi_o = await vm.i_o_module.output.rows();
  await asyncZip(rxs_v, sdi_o, async (rx_v, io) => {
    await io.sdi.v_src.command.write(
      video_ref(rx_v.media_specific.output.video)
    );
  });
  await asyncZip(rxs_a, sdi_o, async (rx_a, io) => {
    await io.a_src.command.write(audio_ref(rx_a.media_specific.output.audio));
  });
  console.log(`finished setting up rxs as sources for sdi outputs`);
}

//Function to restart Ember
async function restart_ember(vm: VAPI.AT1130.Root) {
  await vm.system.services.ember.command.write(false);
  const pause_break = new Duration(1, "s");
  await pause(pause_break);
  await vm.system.services.ember.command.write(true);
}

//Function to stream out before BNC
async function setup_video_transmitter_before_bnc(vm: VAPI.AT1130.Root) {
  enforce(
    !!vm.audio_shuffler &&
      !!vm.i_o_module &&
      !!vm.re_play &&
      !!vm.video_signal_generator &&
      !!vm.audio_signal_generator
  );
  enforce(!!vm.r_t_p_transmitter);
  const videosource_vsg = vm.video_signal_generator.instances.row(0).output;
  const sdi_inputs = await vm.i_o_module.input.rows();
  console.log(`number of sdi inputs: ${sdi_inputs.length}`);

  await asyncIter(sdi_inputs, async () => {
    await stream_video(videosource_vsg);
  });
  
  const txs_v = await vm.r_t_p_transmitter.video_transmitters.rows();
  await asyncZip(sdi_inputs, txs_v, async (inp, tx) => {
    const src = await inp.sdi.hw_status.standard.read();
    tx.v_src.command.write(
      video_ref(src === null ? videosource_vsg : inp.sdi.output.video)
    );
  });
}
//SETUP STARTS HERE
//Scrub AT300
await scrub(vm);
await checkup_ember();
//PTP Setup to FreeRunMaster
console.log("start setting up PTP Clock as FreeRun Master");
await setup_ptp(vm, {
  mode: "FreerunMaster",
  await_calibration: true,
  vlan: 0,
  ptp_domain: 123,
});
console.log("finished setting up ptp");
await setup_vsg(vm);
await setup_io_module(vm);
await setup_samplerate_converter(vm);
await setup_input_audio_shuffler(vm);
await setup_video_audio_transmitters(vm);
await setup_video_transmitter_before_bnc(vm);
await setup_video_audio_receiver(vm);
await patch_rx_audio_video_to_sdi_out(vm);
await restart_ember(vm);
await vm.close();

console.log("finished setting up 16x16 IP-READY ROUTER Demosetup");
