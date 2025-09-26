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
// Adding transmitting of Audioshuffler to blade - done
// Adding Receiver of Audioshuffler to blade - done
// Read out IP Address from other Blade
// Restart Ember - done

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

const vms_inputs: number[] = [];

//Read out IP Address from other Blade
async function connect_second_blade() {
  try {
    const file = FS.readFileSync(
      "/config/ember/config_general_32.json",
      "utf-8"
    );
    const match = file.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    console.log(`founded ip addresses: ${match}`);
    if (match.length > 1) {
      console.log(`${match[1]}`);
      const vm = await VAPI.VM.open({
        ip: match[1] as string,
        protocol: "ws",
        towel: "setup_ipready_demo",
        localAddress: "169.254.42.9",
      });
      console.log("done");
      return vm;
    } else {
      throw Error(`no ip addresses`);
    }
  } catch (error) {
    console.error(`error while reading out file: ${error}`);
  }
  return;
}

//getting connection to the blades
async function get_connections() {
  try {
    const vm_blade1 = await VAPI.VM.open({});
    enforce(vm_blade1 instanceof VAPI.AT1130.Root);
    console.log(`connected to: ${vm_blade1.raw.ip}`);
    const vm_blade2 = await connect_second_blade();
    enforce(vm_blade2 instanceof VAPI.AT1130.Root);
    console.log(`connected to: ${vm_blade2.raw.ip} `);
    return [vm_blade1, vm_blade2];
  } catch (error) {
    console.error(`error while setting up connection to blades: ${error}`);
  }
  return;
}

//setup general_config.json file for ember
async function checkup_ember() {
  if (FS.existsSync("/config/ember/config_general_32.json")) {
    FS.copyFileSync(
      "/config/ember/config_general_32.json",
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
    enforce(!!vm.i_o_module &&!!vm.sample_rate_converter && !!vm.genlock && !!vm.audio_shuffler && !!vm.audio_gain);
    const src = await vm.i_o_module.input.row(i).sdi.hw_status.standard.read();

    const audio_shuffler = await vm.audio_shuffler.instances.create_row();
    await audio_shuffler.genlock.command.write(vm.genlock.instances.row(0));
    let update: any = {};
    for (let index = 0; index < 16; index++) {
      update[index] = src === null ? vm.audio_gain?.instances.row(i).output.channels.reference_to_index(index)
      : vm.sample_rate_converter.instances.row(i).output.channels.reference_to_index(index);
    }
    await audio_shuffler.a_src.command.write(update);
    await audio_shuffler.rename(src===null ? `ASG_GAIN_${i}`: `SDI_SRC_${i}`)
  });
}

async function setup_asg_audio_gain(vm: VAPI.AT1130.Root) {
  const create_level_array = (start: number, decrement: number, target: number, totalLength: number): number[] => {
    const sequenceLength = Math.floor((start - target) / decrement) + 1;
    const sequence = Array.from({ length: sequenceLength }, (_, i) => start - decrement * i).filter(value => value >= target); 
    const padding = Math.max(0, totalLength - sequence.length);
    return [...sequence, ...Array(padding).fill(0)];
  }

  enforce(!!vm.sample_rate_converter);
  await asyncIter(await vm.sample_rate_converter.instances.rows(), async (_,i) => {
    enforce(!!vm.audio_gain && !!vm.genlock && !!vm.audio_shuffler && !!vm.audio_signal_generator);
    const audio_gain = await vm.audio_gain.instances.create_row();
    await audio_gain.a_src.command.write(vm.audio_signal_generator.genlock.row(0).f48000.signal_1000hz.output)
    await audio_gain.rename(`ASG_GAIN_${i}`)
    const level: number[] = create_level_array(6,1,-20,80)
    audio_gain.levels.write(level)
  })

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
    await stream_audio(audiosource, {
      format: { format: "L16", num_channels: 16, packet_time: "p0_125" },
    });
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
      audio_ref(audio_shuffler[idx % audio_shuffler.length].output )
    );
    const name = `${
      src === null ? "ASG" : idx < audio_shuffler.length ? "A_Shuffler" : "ASG"
    }_${idx}`;
    await tx.rename(name);
  });
}

//Setup Transmitter for Audiosrc
//Transmitting every single audio sample rate converter with inputs from SID for the other blades in the the router setup
async function setup_audio_transmitter_src(vm: VAPI.AT1130.Root) {
  console.log(`setting up audiotransmitter for audiosrc`);
  enforce(!!vm.sample_rate_converter && !!vm.audio_signal_generator);
  const audiosrc = await vm.sample_rate_converter.instances.rows();
  for (let src of audiosrc) {
    const s = await vm.i_o_module?.input.row(src.index).sdi.hw_status.standard.read()
    const gains = enforce_nonnull(await vm.audio_gain?.instances.rows())
    const tx = await stream_audio(s === null ? gains[src.index].output : src.output, {
      format: { format: "L24", num_channels: 16, packet_time: "p0_125" },
    });
    tx.rename(`de_embedder_${src.index}`);
  }
}
//Setup Receiver
async function setup_video_audio_receiver(vm: VAPI.AT1130.Root) {
  enforce(!!vm.r_t_p_receiver && !!vm.i_o_module && !!vm.genlock);

  const sdi_outputs = await vm.i_o_module.output.rows();
  console.log(`number of sdi outputs: ${sdi_outputs.length}`);

  await asyncIter(sdi_outputs, async () => {
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
  });
  await asyncIter(sdi_outputs, async () => {
    await create_audio_receiver(vm, {
      channel_capacity: 16,
      supports_clean_switching: true,
      payload_limit: "AtMost1984Bytes",
      read_speed: {
        variant: "LockToGenlock",
        value: { genlock: vm.genlock?.instances.row(0) },
      },
    });
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
  console.log(`restart ember`);
}
//Setup RX for SDI AUDIO-INPUTS
async function setup_rx_sdi_audio_input(
  vm: VAPI.AT1130.Root,
  sdi_inputs: number
) {
  console.log(`number of needed RX: ${sdi_inputs}`);
  for (let i = 0; i < sdi_inputs; i++) {
    const rx = await create_audio_receiver(vm, {
      channel_capacity: 16,
      supports_clean_switching: true,
      payload_limit: "AtMost1984Bytes",
      read_speed: {
        variant: "LockToGenlock",
        value: { genlock: vm.genlock?.instances.row(0) },
      },
    });
    rx.rename(`de_embedder_${i}`);
  }
}
async function patch_raw_sdi_audio_streams(vm_source: VAPI.AT1130.Root, vm_destination: VAPI.AT1130.Root) {
  enforce(!!vm_destination.r_t_p_receiver && !!vm_source.r_t_p_transmitter);
  const tx_a: VAPI.AT1130.RTPTransmitter.AudioStreamerAsNamedTableRow[] = []
  for(let tx of await vm_source.r_t_p_transmitter.audio_transmitters.rows()){
    if((await tx.row_name()).includes("de_embedder")) tx_a.push(tx)
  }
  const rx_a: VAPI.AT1130.RTPReceiver.AudioReceiverAsNamedTableRow[] = []
  for(let rx of await vm_destination.r_t_p_receiver.audio_receivers.rows()){
    if((await rx.row_name()).includes("de_embedder")) rx_a.push(rx)
  }
  console.log(`number audio transmitter raw sdi:${tx_a.length}`)
  console.log(`number audio receiver raw sdi: ${rx_a.length}`)

  await asyncZip(tx_a, rx_a, async (tx, rx) =>{
    const sdp = await tx.generic.ip_configuration.sdp_a.read()
    const s= enforce_nonnull (await rx.generic.hosting_session.status.read())
    s.set_sdp("A", sdp)
  })

};
//Constants for Setup
const vms = enforce_nonnull(await get_connections());
//SETUP STARTS HERE
await checkup_ember();
await asyncIter(vms, async (vm, i) => {
  await scrub(vm);
  //PTP Setup to FreeRunMaster
  console.log("start setting up PTP Clock as FreeRun Master");
  await setup_ptp(vm, {
    mode: i === 1 ? "FreerunMaster" : "SlaveOnly",
    await_calibration: true,
    vlan: 0,
    ptp_domain: 123,
  });
  console.log("finished setting up ptp");
  await setup_vsg(vm);
  await setup_io_module(vm);
  await setup_samplerate_converter(vm);
  await setup_asg_audio_gain(vm)
  await setup_input_audio_shuffler(vm);
  await setup_video_audio_transmitters(vm);
  await setup_audio_transmitter_src(vm);
  await setup_video_audio_receiver(vm);
  await patch_rx_audio_video_to_sdi_out(vm);
  vms_inputs[i] = enforce_nonnull(await vm.i_o_module?.input.rows()).length;
});
await asyncIter(vms_inputs, async (inputs, index) => {
  let vm: VAPI.AT1130.Root = index === 0 ? vms[1] : vms[0];
  await setup_rx_sdi_audio_input(vm, inputs);
});

await patch_raw_sdi_audio_streams(vms[0], vms[1]);
await patch_raw_sdi_audio_streams(vms[1], vms[0]);

//restart ember on machine 1
await restart_ember(vms[0]);

//close connections
await asyncIter(vms, async (vm) => await vm.close());

console.log("finished setting up 16x16 IP-READY ROUTER Demosetup");
