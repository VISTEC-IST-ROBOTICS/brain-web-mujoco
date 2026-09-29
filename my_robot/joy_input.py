#!/usr/bin/env python3
'''
Developer: Menginventor (Dhamdhawach   Horsuwan)
E-mail: dhamdhawach.h_s23@victec.ac.th

This scrpit was design to work with /joy topic from cerebrum/joy_driver.py
ans publish joint position to dynamixel_controller (dxl_ctrl.py).

# still frezzing whem exit..
'''
import rospy
from std_msgs.msg import Int16MultiArray
from sensor_msgs.msg import JointState
from sensor_msgs.msg import Joy
import numpy as np
import rpi_ws281x

def hsb_to_rgb(h, s, b):
    c = b * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = b - c

    if 0 <= h < 60:
        rgb = (c, x, 0)
    elif 60 <= h < 120:
        rgb = (x, c, 0)
    elif 120 <= h < 180:
        rgb = (0, c, x)
    elif 180 <= h < 240:
        rgb = (0, x, c)
    elif 240 <= h < 300:
        rgb = (x, 0, c)
    elif 300 <= h < 360:
        rgb = (c, 0, x)

    r, g, b = [(v + m) * 255 for v in rgb]
    return int(r), int(g), int(b)





class MotionControl:
    RED   = [255,0,0]
    GREEN = [0,255,0]
    BLUE  = [0,0,255]
    PINK  = [255,0,100]
    def __init__(self):
        self.left_analog_x = 0 #-1.0 to 1.0
        self.left_analog_y = 0 #-1.0 to 1.0
        self.right_analog_x = 0 #-1.0 to 1.0
        self.right_analog_y = 0 #-1.0 to 1.0
        # Initialize publisher for JointState message
        self.joint_state_pub = rospy.Publisher('/db_dynamixel_ROS_driver/hexapod_state_commands', JointState, queue_size=10)
        self.cpg = np.array([1,0])
        self.movement_state = 'REST'
        self.move_signal = 0.0
        self.steering_signal = 0.0
        self.pitch_signal = 0.0
        self.red_button = 0
        self.green_button = 0
        self.blue_button = 0
        self.amber_button = 0
        self.led_state = 'OFF'
        self.led_brightness = 0
        self.led_color = [0,0,0]
        self.upper_right = 0 # idx 9
        self.upper_left = 0 # idx 8
        self.lower_left = 0 # idx 10
        self.hue = 0
        
        self.step_high_signal = 0

        
    def update(self, msg):
        # Update joystick data whenever it's received
        self.left_analog_x = msg.axes[0]
        self.left_analog_y = msg.axes[1]
        self.right_analog_x = msg.axes[2]
        self.right_analog_y = msg.axes[3]
        #
        blue_button = msg.buttons[4]
        green_button = msg.buttons[5]
        red_button = msg.buttons[6]
        amber_button = msg.buttons[7]
        upper_right =  msg.buttons[9] # idx 9
        upper_left =  msg.buttons[8] # idx 9
        lower_left =  msg.buttons[10] # idx 9
        #
        
        if self.blue_button != blue_button:
            self.blue_button = blue_button
            if blue_button == 1:
                self.blue_button_pressed()

        if self.green_button != green_button:
            self.green_button = green_button
            if green_button == 1:
                self.green_button_pressed()

        if self.red_button != red_button:
            self.red_button = red_button
            if red_button == 1:
                self.red_button_pressed()
                
        if self.amber_button != amber_button:
            self.amber_button = amber_button
            if amber_button == 1:
                self.amber_button_pressed()
        if blue_button == 1 or green_button ==1 or  red_button == 1:
            if self.led_state == 'ON' and self.led_brightness == 255:
                self.led_state = 'OFF'
            elif self.led_state == 'OFF' and self.led_brightness == 0:
                self.led_state = 'ON'
        
        if self.led_state == 'ON' and self.led_brightness < 255:
            r,g,b = self.led_color
            self.led_brightness +=10
            if self.led_brightness >=255:
                self.led_brightness = 255
            set_leds(self.led_brightness*r//255,self.led_brightness*g//255,self.led_brightness*b//255)
            
        if self.led_state == 'OFF' and self.led_brightness >0:
            r,g,b = self.led_color
            self.led_brightness -=10
            if self.led_brightness <=0:
                self.led_brightness = 0
            set_leds(self.led_brightness*r//255,self.led_brightness*g//255,self.led_brightness*b//255)
        
        if upper_right:
            self.hue += 3
            if self.hue >=360:
                self.hue  -= 360
            
            r,g,b = hsb_to_rgb(self.hue ,1,1)
            set_leds(r,g,b)
        
        if upper_left:
            self.step_high_signal += 0.01
            if self.step_high_signal >1:
                self.step_high_signal = 1
            rospy.loginfo(f"self.step_high_signal :{self.step_high_signal }")
        elif lower_left:
            self.step_high_signal -= 0.01
            if self.step_high_signal <0:
                self.step_high_signal = 0
            rospy.loginfo(f"self.step_high_signal :{self.step_high_signal }")
        
    def blue_button_pressed(self):

        self.led_state = 'ON'
        self.led_brightness = 0
        self.led_color = self.PINK

    def green_button_pressed(self):
        self.led_state = 'ON'
        self.led_brightness = 0
        self.led_color = self.GREEN

    def red_button_pressed(self):
        self.led_state = 'ON'
        self.led_brightness = 0
        self.led_color = self.RED

    def amber_button_pressed(self):
        self.led_state = 'OFF'

    #
    def publish_continuously(self):
        # Create and publish JointState messages continuously at a fixed rate
        joint_state_msg = JointState()
        head = ['id_55']
        spline_group = ['id_45', 'id_15', 'id_25', 'id_35']
        shoulder_swing_group = ['id_11', 'id_12', 'id_13', 'id_14']
        shoulder_stance_group = ['id_21', 'id_22', 'id_23', 'id_24']
        tip_group = ['id_41', 'id_42', 'id_43', 'id_44']
        joint_state_msg.name = head+spline_group + shoulder_swing_group+shoulder_stance_group + tip_group
        update_rate = 50 # 50 Hz
        timestep = 1.0/update_rate
        move_transition_time = 1.0 # time for transition to move
        
        
        if self.movement_state == 'REST':
            self.move_signal = 0.0
            if np.abs(self.left_analog_y) > 0.02:
                self.movement_state = 'MOVE'
        elif self.movement_state == 'MOVE':
            if np.abs(self.left_analog_y) > 0.02: # move
                vel = -self.left_analog_y*2*np.pi*1.5 # rescale to max 1.0 Hz
                
                if self.move_signal < 1.0:
                    self.move_signal += timestep/move_transition_time*np.abs(vel)
                else:
                    # ready to move
                    
                    theta = vel*timestep
                    rot_mat = np.array([[np.cos(theta), -np.sin(theta)],
                                        [np.sin(theta), np.cos(theta)]])
                    self.cpg  = rot_mat@self.cpg
            else:
                if self.move_signal > 0.0:
                    self.move_signal -= timestep/move_transition_time
                else:
                    
                    self.movement_state = 'REST'

        

            
        # Fill in the position with joystick data, the rest can remain zero (or any other values)
        #spline_amplitude = np.deg2rad(12) #TODO: happ comment
        
        #TODO happ added
        if self.green_button == 1:
            spline_amplitude = np.deg2rad(12)*0.0   # fixed spline
        else:
            spline_amplitude = np.deg2rad(12)       # flex spline

        spline_pos_forward = np.array([self.cpg[1]*spline_amplitude]*4)
        spline_pos_left = np.array([-spline_amplitude/2+self.cpg[1]*spline_amplitude/2]*4)
        spline_pos_right = np.array([ spline_amplitude/2+self.cpg[1]*spline_amplitude/2]*4)
        
        steering_filter_weight = 0.9
        self.steering_signal  = steering_filter_weight*self.steering_signal +(1-steering_filter_weight)*self.right_analog_x
        head_pos = np.array([np.deg2rad(20)*self.steering_signal])
        
        forward_weight = 1-abs(self.steering_signal) 
        left_steering_weight = 0
        right_steering_weight = 0
        if self.steering_signal >= 0:
            left_steering_weight = self.steering_signal  # weight, must be positive
        else:
            right_steering_weight = -self.steering_signal # weight, must be positive
        
        spline_pos = forward_weight*spline_pos_forward + left_steering_weight*spline_pos_left + right_steering_weight*spline_pos_right
        #spline_pos = spline_pos_forward
        #rospy.loginfo(f"forward_weight:{forward_weight},steering_weight:{steering_weight}")
        # Shoulder
        shoulder_swing_amplitude = np.deg2rad(16)
        shoulder_swing_pos = np.array([-self.cpg[1]*shoulder_swing_amplitude*(1-right_steering_weight),
                        self.cpg[1]*shoulder_swing_amplitude*(1-right_steering_weight),
                        self.cpg[1]*shoulder_swing_amplitude*(1-left_steering_weight),
                        -self.cpg[1]*shoulder_swing_amplitude*(1-left_steering_weight)])
        
        shoulder_stance_amplitude = np.deg2rad(15)*self.move_signal + np.deg2rad(15)*self.move_signal*self.step_high_signal 
        pitch_filter_weight = 0.1
        
        self.pitch_signal = pitch_filter_weight*self.right_analog_y + (1-pitch_filter_weight)*self.pitch_signal
        
        stance_offset = np.deg2rad(25)
        pitch_range = 2*stance_offset
        front_stance_offset = min(0,-pitch_range * self.pitch_signal) + stance_offset
        rear_stance_offset  = min(0, pitch_range * self.pitch_signal) + stance_offset
        #rospy.loginfo(f"pitch_signal:{self.pitch_signal:.2f},front_stance_offset:{np.rad2deg(front_stance_offset):.2f}")
        shoulder_stance_pos = np.array([-front_stance_offset +self.cpg[0]*shoulder_stance_amplitude, # Front-Left
                                        rear_stance_offset   +self.cpg[0]*shoulder_stance_amplitude, # Rear-Left
                                        -rear_stance_offset  +self.cpg[0]*shoulder_stance_amplitude, # Rear-right
                                        front_stance_offset  +self.cpg[0]*shoulder_stance_amplitude]) # Front-right
        
        tip_pos = shoulder_stance_pos.copy()
        
        
        joint_state_msg.position = np.concatenate((head_pos,spline_pos,shoulder_swing_pos,shoulder_stance_pos,tip_pos))
        
        joint_state_msg.velocity = [0]*len(joint_state_msg.name )
        joint_state_msg.effort = [0]*len(joint_state_msg.name )
        self.cpg = self.cpg
        # Publish the JointState message
        self.joint_state_pub.publish(joint_state_msg)
        #rospy.loginfo(f"Published JointState: {joint_state_msg.position}")
def joy_callback(msg):
    rospy.loginfo(f"Received Joy message: Axes: {msg.axes}, Buttons: {msg.buttons}")


def listener(motion_control):
    rospy.init_node("joy_input", anonymous=True)

    # Subscribe to the /joyStick topic which publishes Int16MultiArray
    #rospy.Subscriber("/joyStick", Int16MultiArray, motion_control.update)
    rospy.Subscriber("/joy", Joy, motion_control.update)

    # Set a publishing rate (e.g., 10 Hz)
    rate = rospy.Rate(50)  # 50 Hz

    # Continuously publish joint state
    while not rospy.is_shutdown():
        motion_control.publish_continuously()
        rate.sleep()
def set_leds(r,g,b):
    strip.setPixelColor(0, rpi_ws281x.Color(r, g, b))
    strip.setPixelColor(1, rpi_ws281x.Color(r, g, b))
    strip.show()

if __name__ == '__main__':
    LED_COUNT = 2       # Number of LEDs
    LED_PIN = 18        # GPIO 18 (PWM)
    LED_BRIGHTNESS = 255
    global strip
    LED_STRIP = rpi_ws281x.WS2811_STRIP_GRB
    strip = rpi_ws281x.PixelStrip(LED_COUNT, LED_PIN, brightness=LED_BRIGHTNESS, strip_type=LED_STRIP)
    strip.begin()
    motion_control = MotionControl()
    listener(motion_control)
