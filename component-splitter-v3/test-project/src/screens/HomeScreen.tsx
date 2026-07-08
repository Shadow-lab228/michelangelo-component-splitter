import React from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';

type Post = {
  id: string;
  title: string;
  body: string;
};

type Props = {
  username: string;
  avatarUrl: string;
  isLoading: boolean;
};

export default function HomeScreen(props: Props) {
  const { username, avatarUrl, isLoading } = props;
  const [posts, setPosts] = React.useState<Post[]>([]);
  const navigation = useNavigation();

  const handleProfilePress = () => {
    navigation.navigate('Profile');
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 16 }}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}>
        <TouchableOpacity onPress={handleProfilePress} testID="profile-button">
          <Image source={{ uri: avatarUrl }} style={{ width: 40, height: 40, borderRadius: 20 }} />
        </TouchableOpacity>
        <Text style={{ fontSize: 18, fontWeight: 'bold' }}>Welcome, {username}</Text>
      </View>

      {/* Feed */}
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Your Feed</Text>
        {posts.map((post) => (
          <View key={post.id} style={{ marginBottom: 20, borderWidth: 1, borderColor: '#eee', borderRadius: 12, padding: 12 }}>
            <Text style={{ fontWeight: '600', marginBottom: 6 }}>{post.title}</Text>
            <Text style={{ color: '#444' }}>{post.body}</Text>
          </View>
        ))}
      </View>

      {/* Footer */}
      <View style={{ padding: 20, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#eee' }}>
        <Text style={{ color: '#999', fontSize: 12 }}>You're all caught up!</Text>
        <Text style={{ color: '#999', fontSize: 12 }}>App version 1.0.0</Text>
      </View>
    </ScrollView>
  );
}
